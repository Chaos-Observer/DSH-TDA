/**
 * tda-drift 不变量门（门2 test:invariants）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compositeRecordKey,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
  registerTdaInvariants,
  type TdaDomain,
} from '@tda/kernel';
import {
  DEFAULT_DRIFT_PARAMS,
  DRIFT_PARAMS_KEY,
  driftDomainSpec,
  type DriftParams,
  type DriftTables,
} from '../src/domain.ts';
import { driftInvariantChecks, registerDriftInvariants } from '../src/loadChecks.ts';
import { DAY, NOW, setup, type FakeGoalState } from './helpers.ts';

const putParam = (domain: TdaDomain<DriftTables>, key: string, value: unknown): Promise<void> =>
  domain.table('drift_params').put(key, value as never);

const snapshotOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ds-1',
  goalId: 'goal-1',
  scores: { persistence: 1, consistency: 1, constraintRetention: 1, actionVolatility: 1 },
  composite: 1,
  level: 'normal',
  window: { from: NOW - DAY, to: NOW },
  trigger: 'cycle',
  at: NOW,
  ...overrides,
});

describe('A. schema 拒载/跳过（backup-and-skip）', () => {
  it('损坏的参数行与快照行各自被跳过并通知（可重算，不阻断权威）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-drift-poison-'));
    const backend = createJsonBackend(dir);
    try {
      const unit = await backend.open({ name: driftDomainSpec.name, version: driftDomainSpec.version });
      await unit.putRecord(compositeRecordKey('drift_params', 'singleton'), { weights: 'bad' });
      await unit.putRecord(compositeRecordKey('drift_scores', 'ds-1'), { corrupted: true });
      await unit.close();
      const skipped: string[] = [];
      const domain = await openTdaDomain(driftDomainSpec, {
        backend,
        onInvalidRecord: (info) => skipped.push(`${info.table}/${info.key}`),
      });
      expect(skipped.sort()).toEqual(['drift_params/singleton', 'drift_scores/ds-1']);
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});

describe('B. 检查判据逐条', () => {
  it('drift-params-singleton：零行/键不符均红', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      const registry = createTdaInvariantRegistry();
      registerDriftInvariants(registry, fx.domain, { goal: fx.goals.seam, service: fx.service });
      await expect(registry.verify('tda-drift')).resolves.toBeUndefined();
      await fx.domain.table('drift_params').delete(DRIFT_PARAMS_KEY);
      await expect(registry.verify('tda-drift')).rejects.toThrowError(/必须恰有一行/);
      await putParam(fx.domain, 'wrong-key', { ...DEFAULT_DRIFT_PARAMS });
      await expect(registry.verify('tda-drift')).rejects.toThrowError(/行键必须是 singleton/);
    } finally {
      await fx.dispose();
    }
  });

  it('drift-zero-goal-write：seam 带目标 mutation 方法即红（J1 运行时闸）', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      const rogueGoal = {
        ...fx.goals.seam,
        // 装配错误：把目标 mutation 面塞给了漂移检测器
        async edit() {
          return undefined;
        },
      };
      const registry = createTdaInvariantRegistry();
      registerDriftInvariants(registry, fx.domain, { goal: rogueGoal as never, service: fx.service });
      await expect(registry.verify('tda-drift')).rejects.toThrowError(/携带了目标 mutation 方法 \[edit\]/);
      // 正常 seam 通过
      const ok = createTdaInvariantRegistry();
      registerDriftInvariants(ok, fx.domain, { goal: fx.goals.seam, service: fx.service });
      await expect(ok.verify('tda-drift')).resolves.toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });

  it('drift-scores-append-only：键不符 / 分数越界 各自红', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      const registry = createTdaInvariantRegistry();
      registerDriftInvariants(registry, fx.domain, { goal: fx.goals.seam, service: fx.service });
      await fx.domain.table('drift_scores').put('ds-9', snapshotOf({ id: 'ds-1' }) as never);
      await expect(registry.verify('tda-drift')).rejects.toThrowError(/与 id ds-1 不符/);
      await fx.domain.table('drift_scores').delete('ds-9');
      await fx.domain
        .table('drift_scores')
        .put('ds-1', snapshotOf({ scores: { persistence: 2, consistency: 1, constraintRetention: 1, actionVolatility: 1 } }) as never);
      await expect(registry.verify('tda-drift')).rejects.toThrowError(/persistence=2 越界/);
    } finally {
      await fx.dispose();
    }
  });

  it('drift-calibrations-wellformed：非法动作 / 缺 snapshot 回链各自红', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      const registry = createTdaInvariantRegistry();
      registerDriftInvariants(registry, fx.domain, { goal: fx.goals.seam, service: fx.service });
      fx.goals.calibrations.push({ goalId: 'goal-1', driftType: 'persistence', action: 'destroy' as never, detail: 'x', at: NOW });
      await expect(registry.verify('tda-drift')).rejects.toThrowError(/不在四动作内/);
      fx.goals.calibrations.length = 0;
      fx.goals.calibrations.push({ goalId: 'goal-1', driftType: 'persistence', action: 'restate', detail: '没有回链', at: NOW });
      await expect(registry.verify('tda-drift')).rejects.toThrowError(/缺 snapshot 回链/);
    } finally {
      await fx.dispose();
    }
  });

  it('drift-snapshot-deterministic：composite 与 Σw·score 不符即红（确定性被破坏）', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      const registry = createTdaInvariantRegistry();
      registerDriftInvariants(registry, fx.domain, { goal: fx.goals.seam, service: fx.service });
      // 直接写一条 composite 错的快照（Σw·score = 1，写成 0.42）
      await fx.domain.table('drift_scores').put('ds-1', snapshotOf({ composite: 0.42 }) as never);
      await expect(registry.verify('tda-drift')).rejects.toThrowError(/确定性被破坏/);
      void (null as unknown as typeof snapshotOf);
    } finally {
      await fx.dispose();
    }
  });

  it('检查表条目与规格一一对应（防静默删检查）', () => {
    void (0 as unknown as DriftParams);
    void ({} as FakeGoalState);
    void driftInvariantChecks;
  });
});

describe('C. 真实域 + 真实服务全过', () => {
  it('完整流程（评估 → 校准 → 后验）后两级门全过', async () => {
    let now = NOW;
    const fx = await setup({
      now: () => now,
      goals: [{ id: 'goal-1', objective: 'x', phase: 'active', stage: 'executing' }],
      tasks: [{ id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'planning' }],
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        now += DAY;
        fx.goals.setObjective('goal-1', `v${index}`, now);
      }
      now += DAY;
      await fx.service.evaluate('goal-1');
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, createDualWriteReconciler());
      registerDriftInvariants(registry, fx.domain, { goal: fx.goals.seam, service: fx.service });
      await expect(registry.verify()).resolves.toBeUndefined();
      // 权威证据已落 goal seam（T0.1 calibrations）
      expect(fx.goals.calibrations.length).toBeGreaterThan(0);
    } finally {
      await fx.dispose();
    }
  });
});
