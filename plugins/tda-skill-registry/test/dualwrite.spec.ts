/**
 * tda-skill-registry 双写对账门（门3）。
 * 四表全部权威（dualWrite + 族 skill/change）；无派生表。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaEventBus,
  openTdaDomain,
  type AuditIndex,
  type DualWriteReconciler,
  type TdaBusEvent,
  type TdaDomain,
} from '@tda/kernel';
import { skillDomainSpec, type SkillTables } from '../src/domain.ts';
import { SKILL_PARAMS_BUSINESS_ID } from '../src/events.ts';
import { createSkillService, type SkillService } from '../src/service.ts';
import { createFakeExecutor, createFakeGovernance, createMemorySink, draftOf, NOW } from './helpers.ts';

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<SkillTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly published: TdaBusEvent[];
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly service: SkillService;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-skill-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(skillDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  const bus = createTdaEventBus();
  const published: TdaBusEvent[] = [];
  bus.subscribe('skill/change', (event) => {
    published.push(event);
  });
  const sink = createMemorySink();
  const governance = createFakeGovernance();
  const service = createSkillService({
    domain,
    session: sink,
    governance: governance.seam as never,
    executor: createFakeExecutor().seam,
    bus,
    reconciler,
    index,
    now: () => NOW,
  });
  await service.initialize();
  return {
    dir,
    backend,
    domain,
    reconciler,
    index,
    published,
    sink,
    service,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

describe('T2.2 双写与审计', () => {
  it('propose/rehearse/logUse/params 全配对；载荷含 Elo 前后值', async () => {
    const rig = await setup();
    try {
      const skill = await rig.service.propose({ actor: 'human', sessionId: 'sess-skill' }, draftOf('dw-skill'));
      await rig.service.rehearse({ actor: 'human', sessionId: 'sess-skill' }, String(skill.id), 'task-1');
      await rig.service.logUse({ actor: 'human', sessionId: 'sess-skill' }, String(skill.id), 'task-1', 'success');
      await rig.service.setParams({ thetaCov: 0.7 });

      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(rig.published.every((event) => event.family === 'skill/change')).toBe(true);
      const useEvent = rig.published.find((event) => event.businessId.startsWith('skill-use:'));
      expect(useEvent).toBeDefined();
      expect((useEvent!.payload as { eloAfter: number }).eloAfter).toBeGreaterThan(1500);
      expect(rig.published.some((event) => event.businessId === SKILL_PARAMS_BUSINESS_ID)).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 记 skill 实体', async () => {
    const rig = await setup();
    try {
      const skill = await rig.service.propose({ actor: 'human', sessionId: 'sess-skill' }, draftOf('idx-skill'));
      const located = rig.index.locate('skill', `skill:${String(skill.id)}`);
      expect(located?.entityId).toBe(`skill:${String(skill.id)}`);
      expect(located?.sessionId).toBe('sess-skill');
    } finally {
      await rig.dispose();
    }
  });

  it('replay-equivalence：params 从 skill/change 日志重建 ⇒ 零差异', async () => {
    const rig = await setup();
    try {
      await rig.service.setParams({ thetaCov: 0.7, eloK: 30 });
      const events = rig.published.map((event) => ({ ...event, at: NOW }));
      const { compareReplay, assertReplayEquivalence } = await import('@tda/testkit');
      const diff = compareReplay(
        events,
        rig.domain.table('skill_params').entries(),
        (event) => (event.businessId === 'params' ? { key: 'singleton', value: event.payload } : undefined),
      );
      expect(() => assertReplayEquivalence(diff)).not.toThrow();
    } finally {
      await rig.dispose();
    }
  });

  it('预检失败：未过阀 propose 不落域不产事件（同名拒绝）', async () => {
    const rig = await setup();
    try {
      await rig.service.propose({ actor: 'human', sessionId: 'sess-skill' }, draftOf('dup-skill'));
      const before = rig.published.length;
      const beforeRows = [...rig.domain.table('skills').keys()].length;
      await expect(
        rig.service.propose({ actor: 'human', sessionId: 'sess-skill' }, draftOf('dup-skill')),
      ).rejects.toMatchObject({ code: 'SKILL_NAME_TAKEN' });
      expect(rig.published.length).toBe(before);
      expect([...rig.domain.table('skills').keys()].length).toBe(beforeRows);
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('直写域即漏双写（对账器抓到）', async () => {
    const rig = await setup();
    try {
      const row = rig.domain.table('skill_params').get('singleton');
      await rig.domain.table('skill_params').put('singleton', { ...row, revision: 42 } as never);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges.some((change) => change.table === 'skill_params')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('canonicalJson 稳定（载荷键序无关）', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});
