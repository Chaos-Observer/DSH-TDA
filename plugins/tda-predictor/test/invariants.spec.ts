/**
 * tda-predictor 不变量门（门2 test:invariants）。
 *
 * 两段：
 *  A. schema 拒载/跳过（全域 backup-and-skip：任何表损坏都是"跳过 + 重建"，
 *     因为 transitions 由 log 重扫、predictions/mismatches 由 `predict/change`
 *     事件重放——两条权威流都在，没有"不可推断"的表）。
 *  B. 检查判据逐条：部分判据需要**schema 非法**的行（它们本就该被 schema 拦下），
 *     故用假域直接喂料——这测的是"检查本身有牙"，而不是再测一遍 schema。
 *  C. 真实域 + 真实服务全过。
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
  type HostRecord,
  type TdaDomain,
  type TdaKvTable,
} from '@tda/kernel';
import {
  EXTRACT_STATE_KEY,
  PREDICT_PARAMS_KEY,
  predictorDomainSpec,
  type Prediction,
  type PredictorTables,
} from '../src/domain.ts';
import { predictorInvariantChecks, registerPredictorInvariants } from '../src/loadChecks.ts';
import { BASE_AT, createMemoryHost, seedFailureHistory, setup, type MemoryHost } from './helpers.ts';

/** 假域：Map 充当各表（绕开 schema 校验墙，专测检查判据）。 */
function fakeDomain(tables: Record<string, Map<string, unknown>>): TdaDomain<PredictorTables> {
  const make = (map: Map<string, unknown>): TdaKvTable<never> =>
    ({
      get: (key: string) => map.get(key),
      keys: () => map.keys(),
      entries: () => map.entries() as IterableIterator<[string, never]>,
      size: () => map.size,
      put: async (key: string, value: never) => {
        map.set(key, value);
      },
      update: async (key: string, mutate: (current: never) => never) => {
        map.set(key, mutate(map.get(key) as never));
      },
      delete: async (key: string) => map.delete(key),
    }) as TdaKvTable<never>;
  return {
    name: 'tda-predictor',
    table: (name: never) => make(tables[name as string] ?? new Map()) as never,
    close: async () => undefined,
  } as unknown as TdaDomain<PredictorTables>;
}

describe('A. schema 拒载/跳过（backup-and-skip）', () => {
  it('transitions / predictions / params 的损坏行各自被跳过并通知', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-predict-poison-'));
    const backend = createJsonBackend(dir);
    try {
      const unit = await backend.open({ name: predictorDomainSpec.name, version: predictorDomainSpec.version });
      await unit.putRecord(compositeRecordKey('transitions', 'tr-1'), { corrupted: true });
      await unit.putRecord(compositeRecordKey('predictions', 'pred-1'), { nope: 1 });
      await unit.putRecord(compositeRecordKey('predict_params', 'singleton'), { weights: 'bad' });
      await unit.close();
      const skipped: string[] = [];
      const domain = await openTdaDomain(predictorDomainSpec, {
        backend,
        onInvalidRecord: (info) => skipped.push(`${info.table}/${info.key}`),
      });
      expect(skipped.sort()).toEqual([
        'predict_params/singleton',
        'predictions/pred-1',
        'transitions/tr-1',
      ]);
      // 跳过而非阻断：域仍可用（认知资产丢了 = 重扫重建，不阻断权威）
      expect(domain.table('transitions').size()).toBe(0);
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});

describe('B. 检查判据逐条（假域喂料）', () => {
  const namesOf = (domain: TdaDomain<PredictorTables>, log?: readonly HostRecord[]): string[] =>
    predictorInvariantChecks(domain, { ...(log !== undefined ? { log } : {}) }).map((check) => check.name);

  it('检查表条目与规格一一对应（防静默删检查）', async () => {
    const names = namesOf(fakeDomain({}));
    expect(names).toEqual([
      'predict-predict-params-singleton',
      'predict-extract-state-singleton',
      'predict-params-valid',
      'predict-low-confidence-not-injected',
      'predict-no-leak',
      'predict-mismatch-ref-integrity',
      'predict-batch-cap',
    ]);
  });

  it('predict-low-confidence-not-injected：低于裁决时 θ 却 injected 即红', async () => {
    const predictions = new Map<string, unknown>([
      [
        'pred-1',
        {
          id: 'pred-1',
          sessionId: 's',
          round: 1,
          context: { stage: 'executing', recentActions: [] },
          nextAction: 'edit:write',
          outcomeDist: { success: 0, failure: 1, partial: 0 },
          riskFlags: [],
          confidence: 0.4,
          theta: 0.55,
          injected: true,
          similarTransitionIds: [],
          at: BASE_AT,
        } as unknown as Prediction,
      ],
    ]);
    const domain = fakeDomain({ predictions, predict_params: new Map([[PREDICT_PARAMS_KEY, {
      thetaPredict: 0.55, topK: 5, simWeights: { taskCls: 1 / 3, actionSeq: 1 / 3, state: 1 / 3 }, mismatchEnabled: true, revision: 0,
    }]]), extract_state: new Map([[EXTRACT_STATE_KEY, { lastSeq: 0, lastAt: 0, batchCap: 1 }]]) });
    const registry = createTdaInvariantRegistry();
    registerPredictorInvariants(registry, domain);
    await expect(registry.verify('tda-predictor')).rejects.toThrowError(/裁决时 θ=0.55 却 injected=true/);
  });

  it('predict-no-leak：分类字段承载正文即红（>64 字符）', async () => {
    const transitions = new Map<string, unknown>([
      [
        'tr-1',
        {
          id: 'tr-1',
          kind: 'tool-call',
          taskStage: 'executing',
          action: { tool: 'x'.repeat(100), argClass: 'read' },
          outcome: { status: 'success' },
          source: { sessionId: 's', seqFrom: 1, seqTo: 1 },
          at: BASE_AT,
        },
      ],
    ]);
    const domain = fakeDomain({
      transitions,
      predictions: new Map(),
      mismatches: new Map(),
      predict_params: new Map([[PREDICT_PARAMS_KEY, {
        thetaPredict: 0.5, topK: 5, simWeights: { taskCls: 1 / 3, actionSeq: 1 / 3, state: 1 / 3 }, mismatchEnabled: true, revision: 0,
      }]]),
      extract_state: new Map([[EXTRACT_STATE_KEY, { lastSeq: 0, lastAt: 0, batchCap: 1 }]]),
    });
    const registry = createTdaInvariantRegistry();
    registerPredictorInvariants(registry, domain);
    await expect(registry.verify('tda-predictor')).rejects.toThrowError(/不得承载正文/);
  });

  it('predict-mismatch-ref-integrity：指向不存在的预测即红', async () => {
    const domain = fakeDomain({
      predictions: new Map(),
      mismatches: new Map([['mm-1', { id: 'mm-1', predictionId: 'pred-404', actual: { action: 'x', outcomeStatus: 'success' }, deltaKind: 'none', at: BASE_AT }]]),
      predict_params: new Map([[PREDICT_PARAMS_KEY, {
        thetaPredict: 0.5, topK: 5, simWeights: { taskCls: 1 / 3, actionSeq: 1 / 3, state: 1 / 3 }, mismatchEnabled: true, revision: 0,
      }]]),
      extract_state: new Map([[EXTRACT_STATE_KEY, { lastSeq: 0, lastAt: 0, batchCap: 1 }]]),
    });
    const registry = createTdaInvariantRegistry();
    registerPredictorInvariants(registry, domain);
    await expect(registry.verify('tda-predictor')).rejects.toThrowError(/引用完整性/);
  });

  it('predict-batch-cap：帽为 0 / 水位为负即红', async () => {
    for (const state of [
      { lastSeq: 0, lastAt: 0, batchCap: 0 },
      { lastSeq: -1, lastAt: 0, batchCap: 10 },
    ]) {
      const domain = fakeDomain({
        predictions: new Map(),
        mismatches: new Map(),
        predict_params: new Map([[PREDICT_PARAMS_KEY, {
          thetaPredict: 0.5, topK: 5, simWeights: { taskCls: 1 / 3, actionSeq: 1 / 3, state: 1 / 3 }, mismatchEnabled: true, revision: 0,
        }]]),
        extract_state: new Map([[EXTRACT_STATE_KEY, state]]),
      });
      const registry = createTdaInvariantRegistry();
      registerPredictorInvariants(registry, domain);
      expect(registry.verify('tda-predictor')).rejects.toThrowError(/batchCap|lastSeq/);
    }
  });

  it('predict-from-events：表与事件分叉即红（预测器权威副本缺失）', async () => {
    const host: MemoryHost = createMemoryHost();
    seedFailureHistory(host, 3);
    const fx = await setup({ host });
    try {
      await fx.service.extract(host);
      await fx.service.predict({ session: host, round: 3 });
      // 篡改域内预测行（模拟旁路写入）
      const key = [...fx.domain.table('predictions').keys()][0]!;
      const row = fx.domain.table('predictions').get(key) as Prediction;
      await fx.domain.table('predictions').put(key, { ...row, nextAction: '被改过的动作' });
      const registry = createTdaInvariantRegistry();
      registerPredictorInvariants(registry, fx.domain, { log: host.records() });
      await expect(registry.verify('tda-predictor')).rejects.toThrowError(/与事件载荷不一致/);
    } finally {
      await fx.dispose();
    }
  });

  it('predict-mismatch-density：已闭合轮次的预测缺 mismatch 即红', async () => {
    const host: MemoryHost = createMemoryHost();
    seedFailureHistory(host, 3);
    const fx = await setup({ host });
    try {
      await fx.service.extract(host);
      await fx.service.predict({ session: host, round: 3 });
      host.turn(BASE_AT + 100_000);
      host.tool({ turn: 3, tool: 'edit', argClass: 'write', status: 'failure', errorClass: 'timeout' }, BASE_AT + 101_000);
      host.close(3, 'failed', BASE_AT + 102_000);
      // 未 observe → 密度检查应红
      const registry = createTdaInvariantRegistry();
      registerPredictorInvariants(registry, fx.domain, { log: host.records() });
      await expect(registry.verify('tda-predictor')).rejects.toThrowError(/没有对应 mismatch/);
      // observe 后转绿
      const prediction = fx.service.predictions({ round: 3 })[0];
      await fx.service.observe(String(prediction?.id), host);
      const registry2 = createTdaInvariantRegistry();
      registerPredictorInvariants(registry2, fx.domain, { log: host.records() });
      await expect(registry2.verify('tda-predictor')).resolves.toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });
});

describe('C. 真实域 + 真实服务全过', () => {
  it('完整流程（抽取 → 预测 → 注入 → 观测）后两级门全过', async () => {
    const host = createMemoryHost();
    seedFailureHistory(host, 3);
    const fx = await setup({ host });
    try {
      await fx.service.extract(host);
      const prediction = await fx.service.predict({ session: host, round: 3 });
      host.turn(BASE_AT + 100_000);
      host.tool({ turn: 3, tool: 'edit', argClass: 'write', status: 'failure', errorClass: 'timeout' }, BASE_AT + 101_000);
      host.close(3, 'failed', BASE_AT + 102_000);
      await fx.service.observe(String(prediction?.id), host);

      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, createDualWriteReconciler());
      registerPredictorInvariants(registry, fx.domain, { log: host.records() });
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });
});
