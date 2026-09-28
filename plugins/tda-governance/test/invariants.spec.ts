/**
 * tda-governance 不变量门（门2 test:invariants）。
 *
 * 三段：
 *  A. **权威分级**：内核 `invalidRecords` 是域级开关，本插件用"域级 backup-and-skip
 *     + apply 里的 gov_actions 闸"实现表级分级——这里验证两个分支各自的行为
 *     （投影/水位损坏 → 跳过；治理权威损坏 → 拒绝启动）。
 *  B. **检查判据逐条**：用桩件（窄只读面）直接喂违规输入，一条不落。
 *  C. **正常域 + 真实服务**全过（含内核门共存）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compositeRecordKey,
  createJsonBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
  registerTdaInvariants,
  createDualWriteReconciler,
  type TdaDomain,
} from '@tda/kernel';
import {
  DEFAULT_GOVERNANCE_WEIGHTS,
  governanceDomainSpec,
  govStateKey,
  type GovAction,
  type GovTables,
  type MemoryGovState,
} from '../src/index.ts';
import { governanceInvariantChecks, registerGovernanceInvariants, type GovReadFace } from '../src/loadChecks.ts';
import { NOW, createFakeTimeline, setup } from './helpers.ts';

const withDomain = async <T>(
  run: (domain: TdaDomain<GovTables>, backend: ReturnType<typeof createJsonBackend>) => Promise<T>,
): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'tda-gov-inv-'));
  const backend = createJsonBackend(dir);
  try {
    const domain = await openTdaDomain(governanceDomainSpec, { backend });
    try {
      return await run(domain, backend);
    } finally {
      await domain.close();
    }
  } finally {
    await backend.close();
    // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
  }
};

/** 桩只读面：检查判据可被精确喂料。 */
const stubFace = (input: { actions?: readonly GovAction[]; states?: readonly MemoryGovState[] }): GovReadFace => {
  const states = new Map((input.states ?? []).map((state) => [govStateKey(state.assetKind, state.assetId), state]));
  return {
    actions: () => input.actions ?? [],
    rebuildStates: () => new Map(states),
  };
};

const actionOf = (overrides: Omit<Partial<GovAction>, 'id' | 'assetId'> & { id: string; assetId: string }): GovAction => {
  const { id, ...rest } = overrides;
  return {
    id: id as never,
    assetKind: 'memory',
    action: 'propose',
    actor: { sessionId: 'sess-1', actor: 'scheduler', at: NOW },
    at: NOW,
    ...rest,
  } as GovAction;
};

const stateOf = (overrides: Partial<MemoryGovState> & { assetId: string }): MemoryGovState =>
  ({
    assetKind: 'memory',
    lifecycle: 'draft',
    archived: false,
    credential: 'model-produced',
    verifiedBy: [],
    reuseCount: 0,
    updatedAt: NOW,
    ...overrides,
  }) as MemoryGovState;

/** 桩状态必须同步落域：否则 gov-states-match-projection 会先判"有动作日志却无状态行"。 */
const seedStates = async (domain: TdaDomain<GovTables>, states: readonly MemoryGovState[]): Promise<void> => {
  for (const state of states) await domain.table('memory_gov_states').put(govStateKey(state.assetKind, state.assetId), state);
};

describe('A. 权威分级（表级 reject / backup-and-skip）', () => {
  it('投影与水位损坏 → 跳过开域并通知（域仍可用）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-gov-skip-'));
    const backend = createJsonBackend(dir);
    try {
      const unit = await backend.open({ name: governanceDomainSpec.name, version: governanceDomainSpec.version });
      await unit.putRecord(compositeRecordKey('memory_gov_states', 'memory#tl-1'), { corrupted: true });
      await unit.putRecord(compositeRecordKey('gov_scan_state', 'singleton'), { nope: 1 });
      await unit.close();
      const skipped: string[] = [];
      const domain = await openTdaDomain(governanceDomainSpec, {
        backend,
        onInvalidRecord: (info) => skipped.push(`${info.table}/${info.key}`),
      });
      expect(skipped.sort()).toEqual(['gov_scan_state/singleton', 'memory_gov_states/memory#tl-1']);
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('gov_actions 损坏 → 插件拒绝启动（GOV_AUTHORITY_CORRUPTED，fail-loud）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-gov-corrupt-'));
    const backend = createJsonBackend(dir);
    try {
      const unit = await backend.open({ name: governanceDomainSpec.name, version: governanceDomainSpec.version });
      await unit.putRecord(compositeRecordKey('gov_actions', 'gov-1'), { action: 'not-a-kind' });
      await unit.close();
      const { tdaGovernancePlugin } = await import('../src/index.ts');
      await expect(
        tdaGovernancePlugin.apply({
          storage: backend,
          invariants: createTdaInvariantRegistry(),
          session: {
            sessionId: 'sess-x' as never,
            append: () => 1,
            flush: () => undefined,
          },
          timeline: createFakeTimeline(),
        }),
      ).rejects.toMatchObject({ code: 'GOV_AUTHORITY_CORRUPTED' });
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});

describe('B. 检查判据逐条（桩件喂料）', () => {
  it('gov-scan-state-singleton：零行/键不符均红', async () => {
    await withDomain(async (domain) => {
      const registry = createTdaInvariantRegistry();
      registerGovernanceInvariants(registry, domain, { service: stubFace({}) });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/必须恰有一行/);
      await domain.table('gov_scan_state').put('wrong', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/行键必须是 singleton/);
    });
  });

  it('gov-actions-id-canonical：键与 id 不符即红', async () => {
    await withDomain(async (domain) => {
      await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      const action = actionOf({ id: 'gov-1', assetId: 'tl-1' });
      await domain.table('gov_actions').put('gov-9', action);
      const registry = createTdaInvariantRegistry();
      registerGovernanceInvariants(registry, domain, { service: stubFace({}) });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/与 id gov-1 不符/);
    });
  });

  it('gov-states-match-projection：投影漂移/幽灵状态/缺状态行三类各自红', { timeout: 30_000 }, async () => {
    // 漂移：库里的行与重放结果不同
    const drifted = stateOf({ assetId: 'tl-1', lifecycle: 'consolidated' });
    await withDomain(async (domain) => {
      await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      await domain.table('memory_gov_states').put(govStateKey('memory', 'tl-1'), drifted);
      const registry = createTdaInvariantRegistry();
      registerGovernanceInvariants(registry, domain, { service: stubFace({ states: [stateOf({ assetId: 'tl-1' })] }) });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/投影漂移|重放结果不一致/);
    });
    // 幽灵：库里有、重放没有
    await withDomain(async (domain) => {
      await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      await domain.table('memory_gov_states').put(govStateKey('memory', 'tl-2'), stateOf({ assetId: 'tl-2' }));
      const registry = createTdaInvariantRegistry();
      registerGovernanceInvariants(registry, domain, { service: stubFace({}) });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/幽灵状态/);
    });
    // 缺行：有动作日志却无状态行
    await withDomain(async (domain) => {
      await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      const registry = createTdaInvariantRegistry();
      registerGovernanceInvariants(registry, domain, { service: stubFace({ states: [stateOf({ assetId: 'tl-3' })] }) });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/有动作日志却无状态行/);
    });
  });

  it('gov-capacity-ranking：capacity 动作无 ranking 或无 rank= 明细即红', async () => {
    const base = {
      kind: 'capacity' as const,
      detail: 'rank=1/2 score=0.1',
    };
    await withDomain(async (domain) => {
      await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      await seedStates(domain, [stateOf({ assetId: 'tl-1', lifecycle: 'retired', retiredReason: base })]);
      const registry = createTdaInvariantRegistry();
      registerGovernanceInvariants(registry, domain, {
        service: stubFace({
          actions: [actionOf({ id: 'gov-1', assetId: 'tl-1', action: 'retire', to: 'retired', reason: base })],
          states: [stateOf({ assetId: 'tl-1', lifecycle: 'retired', retiredReason: base })],
        }),
      });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/无 ranking 快照/);
    });
    await withDomain(async (domain) => {
      await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      const states = [
        stateOf({ assetId: 'tl-1', lifecycle: 'retired', retiredReason: { kind: 'capacity', detail: '无排名信息' } }),
      ];
      await seedStates(domain, states);
      const registry = createTdaInvariantRegistry();
      registerGovernanceInvariants(registry, domain, {
        service: stubFace({
          actions: [
            actionOf({
              id: 'gov-1',
              assetId: 'tl-1',
              action: 'retire',
              to: 'retired',
              reason: { kind: 'capacity', detail: '无排名信息' },
              ranking: [{ assetId: 'tl-1', score: 0.1, reuseCount: 0, credentialRank: 1 }],
              approvalToken: 'tok',
            }),
          ],
          states,
        }),
      });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/未含排名/);
    });
  });

  it('gov-restore-by-human：非人工恢复 / 容量淘汰无 token 均红', async () => {
    await withDomain(async (domain) => {
      await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      await seedStates(domain, [stateOf({ assetId: 'tl-1', lifecycle: 'consolidated' })]);
      const registry = createTdaInvariantRegistry();
      registerGovernanceInvariants(registry, domain, {
        service: stubFace({
          actions: [actionOf({ id: 'gov-1', assetId: 'tl-1', action: 'restore', from: 'retired', to: 'consolidated' })],
          states: [stateOf({ assetId: 'tl-1', lifecycle: 'consolidated' })],
        }),
      });
    });
    await withDomain(async (domain) => {
      await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      const registry = createTdaInvariantRegistry();
      const states = [
        stateOf({ assetId: 'tl-1', lifecycle: 'retired', retiredReason: { kind: 'capacity', detail: 'rank=1/1 score=0' } }),
      ];
      await seedStates(domain, states);
      registerGovernanceInvariants(registry, domain, {
        service: stubFace({
          actions: [
            actionOf({
              id: 'gov-1',
              assetId: 'tl-1',
              action: 'retire',
              to: 'retired',
              reason: { kind: 'capacity', detail: 'rank=1/1 score=0' },
              ranking: [{ assetId: 'tl-1', score: 0, reuseCount: 0, credentialRank: 0 }],
            }),
          ],
          states,
        }),
      });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/未经人类审批/);
    });
  });

  it('gov-archive-terminal：作废后仍有治理动作即红', async () => {
    await withDomain(async (domain) => {
      await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      await seedStates(domain, [stateOf({ assetId: 'tl-1', lifecycle: 'retired', archived: true, retiredReason: { kind: 'manual', detail: 'x' } })]);
      const registry = createTdaInvariantRegistry();
      registerGovernanceInvariants(registry, domain, {
        service: stubFace({
          actions: [
            actionOf({ id: 'gov-1', assetId: 'tl-1', action: 'propose-invalidate', approvalToken: 'tok', at: NOW }),
            actionOf({ id: 'gov-2', assetId: 'tl-1', action: 'retire', to: 'retired', reason: { kind: 'manual', detail: 'x' }, at: NOW + 1000 }),
          ],
          states: [stateOf({ assetId: 'tl-1', lifecycle: 'retired', archived: true, retiredReason: { kind: 'manual', detail: 'x' } })],
        }),
      });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/作废后仍有治理动作 retire/);
    });
  });

  it('gov-promote-new-entry：转正新条目未 supersedes 原条目即红（隔离史断链）', async () => {
    const timeline = createFakeTimeline([
      { id: 'tl-1', content: '隔离原文', credential: 'tool-output', createdAt: NOW - 1000 },
      { id: 'tl-2', content: '转正副本', credential: 'execution-verified', createdAt: NOW },
    ]);
    await withDomain(async (domain) => {
      await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      await seedStates(domain, [stateOf({ assetId: 'tl-2', lifecycle: 'validating', credential: 'execution-verified' })]);
      const registry = createTdaInvariantRegistry();
      registerGovernanceInvariants(registry, domain, {
        service: stubFace({
          actions: [
            actionOf({
              id: 'gov-1',
              assetId: 'tl-2',
              action: 'promote',
              from: 'draft',
              to: 'validating',
              promotedFrom: 'tl-1',
              reason: { kind: 'verify-pass', detail: 'x' },
            }),
          ],
          states: [stateOf({ assetId: 'tl-2', lifecycle: 'validating', credential: 'execution-verified' })],
        }),
        timeline,
      });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/supersedes=undefined ≠ 原隔离条目 tl-1/);
    });
  });

  it('gov-consolidated-conditions：无证据/凭证不足/仍隔离三类各自红', { timeout: 30_000 }, async () => {
    const timeline = createFakeTimeline([
      { id: 'tl-1', content: 'a', credential: 'model-produced', createdAt: NOW },
      { id: 'tl-2', content: 'b', credential: 'tool-output', createdAt: NOW },
    ]);
    const cases: readonly { readonly state: MemoryGovState; readonly pattern: RegExp }[] = [
      { state: stateOf({ assetId: 'tl-1', lifecycle: 'consolidated', credential: 'model-produced' }), pattern: /无外部验证证据/ },
      {
        state: stateOf({
          assetId: 'tl-1',
          lifecycle: 'consolidated',
          credential: 'model-produced',
          verifiedBy: [{ taskId: 't', runIndex: 1, taskOutcome: 'success', injectedAt: NOW, checkedAt: NOW }],
        }),
        pattern: /低于 execution-verified/,
      },
      {
        state: stateOf({
          assetId: 'tl-2',
          lifecycle: 'consolidated',
          credential: 'execution-verified',
          verifiedBy: [{ taskId: 't', runIndex: 1, taskOutcome: 'success', injectedAt: NOW, checkedAt: NOW }],
        }),
        pattern: /仍隔离/,
      },
    ];
    for (const item of cases) {
      await withDomain(async (domain) => {
        await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
        await seedStates(domain, [item.state]);
        const registry = createTdaInvariantRegistry();
        registerGovernanceInvariants(registry, domain, { service: stubFace({ states: [item.state] }), timeline });
        await expect(registry.verify('tda-governance')).rejects.toThrowError(item.pattern);
      });
    }
  });

  it('gov-state-refs-resolvable：状态指向不存在的条目即红（弱引用断链）', async () => {
    const timeline = createFakeTimeline([]);
    await withDomain(async (domain) => {
      await domain.table('gov_scan_state').put('singleton', { lastScanAt: 0, cursor: '', cycleMs: 1, caps: { maxActions: 1, maxScanned: 1 } });
      const states = [stateOf({ assetId: 'tl-404' })];
      await seedStates(domain, states);
      const registry = createTdaInvariantRegistry();
      registerGovernanceInvariants(registry, domain, { service: stubFace({ states }), timeline });
      await expect(registry.verify('tda-governance')).rejects.toThrowError(/不在时间线/);
    });
  });

  it('检查表条目与规格一一对应（防静默删检查）', async () => {
    const timeline = createFakeTimeline([]);
    await withDomain(async (domain) => {
      const names = governanceInvariantChecks(domain, { service: stubFace({}), timeline }).map((check) => check.name);
      expect(names).toEqual([
        'gov-scan-state-singleton',
        'gov-actions-id-canonical',
        'gov-states-match-projection',
        'gov-capacity-ranking',
        'gov-restore-by-human',
        'gov-archive-terminal',
        'gov-promote-new-entry',
        'gov-consolidated-conditions',
        'gov-state-refs-resolvable',
      ]);
    });
  });
});

describe('C. 真实域 + 真实服务全过', () => {
  it('完整流程（转正 → 固化 → 退役 → 恢复 → 作废）后两级门全过', async () => {
    const fx = await setup({
      now: () => NOW,
      config: { unusedDays: 3650 },
      entries: [{ id: 'tl-1', content: 'x', credential: 'execution-verified', chunkType: 'method', relatedTaskId: 'task-1', createdAt: NOW }],
      recall: [{ entryId: 'tl-1', at: NOW, injected: true, kind: 'inject', taskId: 'task-1' }],
      tasks: [{ id: 'task-1', outcome: 'success' }],
    });
    try {
      await fx.service.promote({ actor: 'scheduler', sessionId: 'sess-gov' }, 'tl-1', {
        taskId: 'task-1',
        runIndex: 1,
        taskOutcome: 'success',
        injectedAt: NOW,
        checkedAt: NOW,
      });
      await fx.service.consolidate({ actor: 'scheduler', sessionId: 'sess-gov' }, 'tl-1');
      await fx.service.retire({ actor: 'agent', sessionId: 'sess-gov' }, 'tl-1', { kind: 'manual', detail: 'x' });
      await fx.service.restore({ actor: 'human', sessionId: 'sess-human' }, 'tl-1');

      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, createDualWriteReconciler());
      registerGovernanceInvariants(registry, fx.domain, { service: fx.service, timeline: fx.timeline });
      await expect(registry.verify()).resolves.toBeUndefined();
      expect(fx.service.rebuildStates().size).toBe(1);
      expect(DEFAULT_GOVERNANCE_WEIGHTS.reuse).toBe(0.5);
    } finally {
      await fx.dispose();
    }
  });
});
