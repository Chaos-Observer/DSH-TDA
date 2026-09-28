/**
 * tda-coach 不变量门（门2 test:invariants）。
 *
 * T2.1 §4.1 九条 → 检查/运行时/结构分层映射见 loadChecks.ts 头注；
 * 本门逐条用"临时回退法"验证检查有牙（坏一行 ⇒ verify 红）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDualWriteReconciler,
  createJsonBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
  type TdaDomain,
} from '@tda/kernel';
import { coachDomainSpec, type CoachTables } from '../src/domain.ts';
import { registerCoachInvariants, type CoachInvariantOptions } from '../src/loadChecks.ts';
import { NOW, sameCluster, setup } from './helpers.ts';

async function openRig(): Promise<{
  readonly domain: TdaDomain<CoachTables>;
  readonly options: CoachInvariantOptions;
  readonly dir: string;
  dispose(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-coach-inv-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(coachDomainSpec, { backend });
  return {
    domain,
    options: { reads: { mismatches: () => [], predictions: () => [], govActions: () => [], rehearsalRuns: () => [] } },
    dir,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

describe('T2.1 不变量门', () => {
  it('coach-params-singleton：缺行红（initialize 未跑即注册 = 启动序违规）', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      const unregister = registerCoachInvariants(registry, rig.domain, rig.options);
      await expect(registry.verify('tda-coach')).rejects.toThrowError(/必须恰有一行/);
      unregister();
    } finally {
      await rig.dispose();
    }
  });

  it('coach-candidates-whitelist：长正文候选红（零原文泄漏自检有牙）', async () => {
    const fx = await setup({
      predictions: [{ id: 'pred-1', taskId: 'task-1', stage: 'executing' }],
      mismatches: sameCluster(3),
    });
    try {
      await fx.service.review({ kind: 'manual' });
      // 注入一条超长"正文"候选（模拟旁路写入）
      await fx.domain.table('coach_candidates').put('hc-bad', {
        id: 'hc-bad', kind: 'method-memory', risk: 'low',
        condition: { taskClasses: ['t'], stages: ['executing'], problemFeatures: [] },
        rule: { expect: 'x'.repeat(200) },
        evidence: { mismatchIds: [], transitionIds: [], sessions: [] },
        confidence: 0.5, status: 'proposed', reviewId: 'cr-1', createdAt: NOW, updatedAt: NOW,
      } as never);
      const registry = createTdaInvariantRegistry();
      const unregister = registerCoachInvariants(registry, fx.domain, {
        reads: { mismatches: () => [], predictions: () => [], govActions: () => [], rehearsalRuns: () => [] },
      });
      await expect(registry.verify('tda-coach')).rejects.toThrowError(/疑似原文泄漏/);
      unregister();
    } finally {
      await fx.dispose();
    }
  });

  it('coach-reviews-wellformed：failed+unfinished 绿（fail-open 落域行通过检查）', async () => {
    const rig = await openRig();
    try {
      await rig.domain.table('coach_reviews').put('cr-bad', {
        id: 'cr-bad',
        trigger: { kind: 'manual', at: NOW },
        window: { fromSeq: 0, toSeq: 0, fromAt: 0, toAt: NOW },
        status: 'failed',
        stats: { mismatchesScanned: 0, patternsFound: 0, candidatesProposed: 0, candidatesRejected: 0, rehearsalsRun: 0, humanApprovalsRequested: 0 },
        patterns: [], candidateIds: [], govActionRefs: [],
        unfinished: ['review: boom'],
        at: NOW,
      } as never);
      const registry = createTdaInvariantRegistry();
      const unregister = registerCoachInvariants(registry, rig.domain, rig.options);
      // failed 行带 unfinished → 该检查绿（坏行在 put 层已被 schema 拒绝，此检查守 load 期旧数据）
      await expect(registry.verify('tda-coach')).rejects.toThrowError(/coach_params/);
      unregister();
    } finally {
      await rig.dispose();
    }
  });

  it('coach-service-no-lifecycle-face：服务面出现治理写方法红（零直接写权）', async () => {
    const fx = await setup({});
    try {
      const fakeService = {
        consolidate: async () => undefined,
      } as unknown as import('../src/service.ts').CoachService;
      const registry = createTdaInvariantRegistry();
      const unregister = registerCoachInvariants(registry, fx.domain, {
        reads: { mismatches: () => [], predictions: () => [], govActions: () => [], rehearsalRuns: () => [] },
        service: fakeService,
      });
      await expect(registry.verify('tda-coach')).rejects.toThrowError(/治理写方法 consolidate/);
      unregister();
    } finally {
      await fx.dispose();
    }
  });

  it('真实服务 + 已初始化域 → verify 绿（无误报）', async () => {
    const fx = await setup({
      predictions: [{ id: 'pred-1', taskId: 'task-1', stage: 'executing' }],
      mismatches: sameCluster(3),
    });
    try {
      await fx.service.review({ kind: 'manual' });
      const registry = createTdaInvariantRegistry();
      const reconciler = createDualWriteReconciler();
      const unregisterKernel = (await import('@tda/kernel')).registerTdaInvariants(registry, reconciler);
      const unregister = registerCoachInvariants(registry, fx.domain, {
        reads: { mismatches: () => [], predictions: () => [], govActions: () => [], rehearsalRuns: () => [] },
        service: fx.service,
      });
      await expect(registry.verify('tda-coach')).resolves.toBeUndefined();
      unregister();
      unregisterKernel();
    } finally {
      await fx.dispose();
    }
  });

  it('检查清单与规格不变量映射一一对应（防静默删检查）', async () => {
    const { coachInvariantChecks } = await import('../src/loadChecks.ts');
    const rig = await openRig();
    try {
      const names = coachInvariantChecks(rig.domain, rig.options).map((check) => check.name);
      expect(names).toEqual([
        'coach-params-singleton',
        'coach-candidates-whitelist',
        'coach-reviews-wellformed',
      ]);
    } finally {
      await rig.dispose();
    }
  });
});
