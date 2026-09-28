/**
 * tda-subagent-dispatch 不变量门（门2 test:invariants）。
 *
 * 分层验证（§4.1 十条的落点）：
 *  - **schema 恒等律**（invalidRecords=reject）→ 打开即拒：role↔schema 错配、
 *    maxDepth≠0、settled 无 result、terminal 无 settledAt、高风险无审批、
 *    error 却带 conclusionEntryId、diagnostic 超 4096B；
 *  - **加载期检查**→ 打开后校验：孤儿单、token 未消费、策略缺失、任务悬挂引用；
 *  - **静态检查**→ 结论 schema 白名单无指令字段（"返回即执行"的结构阻断）。
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
  InvariantError,
  type TdaDomain,
  type TdaStorageBackend,
} from '@tda/kernel';
import { dispatchDomainSpec, type DispatchTables, type RolePolicy } from '../src/index.ts';
import { registerDispatchInvariants } from '../src/loadChecks.ts';

const policy = (role: 'sidekick' | 'lead'): RolePolicy => ({
  role,
  agentOptions: { provider: 'spawn', model: 'm' },
  toolFilter: ['read_file'],
  maxDepth: 0,
  sandbox: role === 'sidekick' ? 'read-only' : 'workspace-write',
  personaTemplateId: `tda-${role}`,
  maxParallel: 3,
});

const settledOrder = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'dispatch-1',
  revision: 2,
  taskId: 'task-1',
  goalId: 'goal-1',
  role: 'sidekick',
  mode: 'spawn',
  provider: 'spawn',
  agentOptions: { provider: 'spawn', model: 'm' },
  toolFilter: ['read_file'],
  maxDepth: 0,
  sandbox: 'read-only',
  personaTemplateId: 'tda-sidekick-scout',
  outputSchemaId: 'sidekick-conclusion',
  risk: 'low',
  status: 'settled',
  childSessionId: 'sub-1',
  promptHash: 'abcdef0123456789',
  result: {
    stopReason: 'completed',
    outcome: 'conclusion',
    conclusionEntryId: 'tl-1',
    summary: { findings: ['a'], confidence: 1 },
    consumed: { tokens: 1, toolCalls: 1, wallClockMs: 1 },
  },
  createdAt: 1,
  settledAt: 2,
  ...overrides,
});

/** 注记录（绕过写入侧类型，专测加载期 schema/检查；运行期形态由服务保证）。 */
const putOrder = (
  domain: TdaDomain<DispatchTables>,
  key: string,
  record: Record<string, unknown>,
): Promise<void> => domain.table('dispatch_orders').put(key, record as never);

async function withDomain<T>(
  seed: (domain: TdaDomain<DispatchTables>) => Promise<void>,
  body: (domain: TdaDomain<DispatchTables>, backend: TdaStorageBackend) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-dispatch-inv-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(dispatchDomainSpec, { backend });
  try {
    await seed(domain);
    return await body(domain, backend);
  } finally {
    await domain.close();
    await backend.close();
    // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
  }
}

/** 打开一个带预置记录的新域（schema 拒载场景专用）。 */
async function openWith(records: readonly Record<string, unknown>[]): Promise<{
  domain: TdaDomain<DispatchTables> | undefined;
  error: unknown;
  close(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-dispatch-reject-'));
  const backend = createJsonBackend(dir);
  // 走 raw unit 落盘（键 = compositeRecordKey(table, key)），再让真实 spec 打开：
  // 这样能精确测"schema 拒载"，而不被 domain 的写入侧校验先行拦住
  const unit = await backend.open({ name: dispatchDomainSpec.name, version: dispatchDomainSpec.version });
  let index = 0;
  for (const record of records) {
    index += 1;
    await unit.putRecord(compositeRecordKey('dispatch_orders', `dispatch-${index}`), record);
  }
  await unit.close();
  let domain: TdaDomain<DispatchTables> | undefined;
  let error: unknown;
  try {
    domain = await openTdaDomain(dispatchDomainSpec, { backend });
  } catch (caught) {
    error = caught;
  }
  return {
    domain,
    error,
    async close() {
      await domain?.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

describe('T0.5 schema 恒等律（invalidRecords=reject：打开即拒）', () => {
  it('role 与 outputSchemaId 错配即拒', async () => {
    const fx = await openWith([settledOrder({ outputSchemaId: 'lead-conclusion' })]);
    try {
      expect(fx.domain).toBeUndefined();
      expect(String(fx.error)).toMatch(/outputSchemaId|结论 schema/);
    } finally {
      await fx.close();
    }
  });

  it('maxDepth≠0 即拒（子代理禁再委派）', async () => {
    const fx = await openWith([settledOrder({ maxDepth: 1 })]);
    try {
      expect(fx.domain).toBeUndefined();
      expect(fx.error).toBeDefined();
    } finally {
      await fx.close();
    }
  });

  it('settled 无 result / outcome=error 却带 conclusionEntryId 即拒', async () => {
    const noResult = await openWith([settledOrder({ result: undefined })]);
    try {
      expect(noResult.domain).toBeUndefined();
    } finally {
      await noResult.close();
    }
    const badRef = await openWith([
      settledOrder({
        result: {
          stopReason: 'error',
          outcome: 'error',
          conclusionEntryId: 'tl-9',
          consumed: { tokens: 0, toolCalls: 0, wallClockMs: 0 },
        },
      }),
    ]);
    try {
      expect(badRef.domain).toBeUndefined();
      expect(String(badRef.error)).toMatch(/conclusionEntryId/);
    } finally {
      await badRef.close();
    }
  });

  it('高风险无审批 / 已开跑仍持 token 即拒', async () => {
    const noApproval = await openWith([settledOrder({ risk: 'high', approval: undefined })]);
    try {
      expect(noApproval.domain).toBeUndefined();
      expect(String(noApproval.error)).toMatch(/approval/);
    } finally {
      await noApproval.close();
    }
    const retained = await openWith([
      settledOrder({
        risk: 'high',
        approval: { status: 'approved', at: 1, by: 'human', token: 'tok-x' },
      }),
    ]);
    try {
      expect(retained.domain).toBeUndefined();
      expect(String(retained.error)).toMatch(/token/);
    } finally {
      await retained.close();
    }
  });
});

describe('T0.5 加载期检查', () => {
  it('合法域全部通过', async () => {
    await withDomain(
      async (domain) => {
        await domain.table('dispatch_policy').put('sidekick', policy('sidekick'));
        await domain.table('dispatch_policy').put('lead', policy('lead'));
        await putOrder(domain, 'dispatch-1', settledOrder());
      },
      async (domain) => {
        const registry = createTdaInvariantRegistry();
        registerDispatchInvariants(registry, domain);
        await expect(registry.verify()).resolves.toBeUndefined();
      },
    );
  });

  it('孤儿单（停在 running）被拒——须经 reconcileOrphans 落显式终态', async () => {
    await withDomain(
      async (domain) => {
        await domain.table('dispatch_policy').put('sidekick', policy('sidekick'));
        await domain.table('dispatch_policy').put('lead', policy('lead'));
        await putOrder(domain, 'dispatch-1',
          settledOrder({
            revision: 2,
            status: 'running',
            result: undefined,
            settledAt: undefined,
            childSessionId: 'sub-1',
          }),
        );
      },
      async (domain) => {
        const registry = createTdaInvariantRegistry();
        // bootAt=100：建单时刻 1 早于本次启动 → 真孤儿（重启未收口）
        registerDispatchInvariants(registry, domain, { bootAt: 100 });
        await expect(registry.verify()).rejects.toThrow(InvariantError);
        await expect(registry.verify()).rejects.toThrow(/落显式终态/);

        // 反向：本次启动之后建的在途单是"正在飞"，不得误伤（装配期教训）
        const live = createTdaInvariantRegistry();
        registerDispatchInvariants(live, domain, { bootAt: 0 });
        await expect(live.verify()).resolves.toBeUndefined();
      },
    );
  });

  it('已开跑却留下未获批的审批记录被拒（防绕过审批门）', async () => {
    await withDomain(
      async (domain) => {
        await domain.table('dispatch_policy').put('sidekick', policy('sidekick'));
        await domain.table('dispatch_policy').put('lead', policy('lead'));
        await putOrder(domain, 'dispatch-1',
          settledOrder({
            status: 'running',
            result: undefined,
            settledAt: undefined,
            approval: { status: 'pending', at: 1 },
          }),
        );
      },
      async (domain) => {
        const registry = createTdaInvariantRegistry();
        registerDispatchInvariants(registry, domain);
        await expect(registry.verify()).rejects.toThrow(/审批状态/);
      },
    );
  });

  it('策略缺失被拒（两角色必覆盖）', async () => {
    await withDomain(
      async (domain) => {
        await domain.table('dispatch_policy').put('sidekick', policy('sidekick'));
        await putOrder(domain, 'dispatch-1', settledOrder());
      },
      async (domain) => {
        const registry = createTdaInvariantRegistry();
        registerDispatchInvariants(registry, domain);
        await expect(registry.verify()).rejects.toThrow(/角色 lead 无策略行/);
      },
    );
  });

  it('任务悬挂引用被拒（装配任务池 seam 时启用）', async () => {
    await withDomain(
      async (domain) => {
        await domain.table('dispatch_policy').put('sidekick', policy('sidekick'));
        await domain.table('dispatch_policy').put('lead', policy('lead'));
        await putOrder(domain, 'dispatch-1', settledOrder({ taskId: 'task-ghost' }));
      },
      async (domain) => {
        const registry = createTdaInvariantRegistry();
        registerDispatchInvariants(registry, domain, { taskExists: (id) => id === 'task-1' });
        await expect(registry.verify()).rejects.toThrow(/不存在的任务 task-ghost/);
      },
    );
  });
});

describe('T0.5 静态结构检查（输入/输出隔离的类型级落点）', () => {
  it('结论 schema 白名单无任务指令类字段；两套 schema 均 object-rooted 且禁附加属性', async () => {
    const { CONCLUSION_SCHEMAS, schemaFieldNames, FORBIDDEN_SCHEMA_FIELDS } = await import('../src/schema.ts');
    for (const [schemaId, schema] of Object.entries(CONCLUSION_SCHEMAS)) {
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      const names = schemaFieldNames(schema);
      for (const name of names) {
        expect(FORBIDDEN_SCHEMA_FIELDS).not.toContain(name);
      }
      expect(schemaId).toMatch(/(conclusion|annotation)$/);
    }
    // lead-conclusion 是 sidekick 的超集（critic 载体）
    const sidekick = schemaFieldNames(CONCLUSION_SCHEMAS['sidekick-conclusion']);
    const lead = schemaFieldNames(CONCLUSION_SCHEMAS['lead-conclusion']);
    for (const name of sidekick) expect(lead).toContain(name);
    expect(lead).toContain('verdict');
    expect(lead).toContain('critiques');
  });
});

describe('T0.5 角色 ↔ schema 对应律（T0.6 标注 schema 内嵌）', () => {
  it('默认 schema 按角色取首项；内部消费方也不能越角色用 schema', async () => {
    const domain = await import('../src/domain.ts');
    expect(domain.defaultSchemaOf('sidekick')).toBe('sidekick-conclusion');
    expect(domain.defaultSchemaOf('lead')).toBe('lead-conclusion');
    expect(domain.ROLE_SCHEMAS.sidekick).toContain('sidekick-workspace-annotation');
    expect(domain.ROLE_SCHEMAS.lead).not.toContain('sidekick-workspace-annotation');
    expect(domain.ROLE_SCHEMAS.lead).toEqual(['lead-conclusion']);
  });

  it('工作区标注 schema 是 sidekick-conclusion 的超集且同样无指令类字段', async () => {
    const schema = await import('../src/schema.ts');
    const base = schema.schemaFieldNames(schema.SIDEKICK_CONCLUSION_SCHEMA);
    const annotation = schema.schemaFieldNames(schema.SIDEKICK_WORKSPACE_ANNOTATION_SCHEMA);
    for (const name of base) expect(annotation).toContain(name);
    for (const name of ['files', 'edges', 'notes', 'path', 'role', 'credibilityHint']) {
      expect(annotation).toContain(name);
    }
    for (const name of annotation) {
      expect(schema.FORBIDDEN_SCHEMA_FIELDS).not.toContain(name);
    }
    expect(() =>
      schema.assertConclusionSchema('sidekick-workspace-annotation', schema.SIDEKICK_WORKSPACE_ANNOTATION_SCHEMA),
    ).not.toThrow();
  });
});
