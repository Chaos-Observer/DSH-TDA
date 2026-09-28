/**
 * 门2 · 不变量门：内核级不变量与 fail-loud 边界回归。
 *
 * 覆盖：defineTdaDomain fail-loud / invalidRecords 分级（reject vs backup-and-skip）/
 *       CAS 不匹配即抛 / id 无洞分配与空间耗尽 / 漏双写触发内核不变量。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  allocateId,
  cas,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaInvariantRegistry,
  defineTdaDomain,
  dualWrite,
  IdSpaceExhaustedError,
  InvariantError,
  openTdaDomain,
  registerTdaInvariants,
  StaleRevisionError,
  TDA_KERNEL_PACKAGE,
} from '../src/index.ts';
import { createMemorySink, expectTdaError, expectTdaErrorAsync, makeTempDir, removeTempDir } from './helpers.ts';

const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  revision: z.number(),
});

const goalSpec = defineTdaDomain({
  name: 'smoke-goals',
  version: 1,
  tables: { goals: GoalSchema },
});

describe('defineTdaDomain：模块加载即 fail-loud', () => {
  it('拒绝非法 domain 名 / 表名 / 版本 / 策略 / layout', () => {
    expectTdaError(
      () => defineTdaDomain({ name: '非法 domain', version: 1, tables: { goals: GoalSchema } }),
      'INVALID_DOMAIN_NAME',
    );
    expectTdaError(
      () => defineTdaDomain({ name: 'ok', version: 1, tables: { '坏 表': GoalSchema } }),
      'INVALID_TABLE_NAME',
    );
    expectTdaError(
      () => defineTdaDomain({ name: 'ok', version: -1, tables: { goals: GoalSchema } }),
      'INVALID_DOMAIN_VERSION',
    );
    expectTdaError(
      () =>
        defineTdaDomain({
          name: 'ok',
          version: 1,
          tables: { goals: GoalSchema },
          invalidRecords: 'skip' as never,
        }),
      'INVALID_INVALID_RECORDS_POLICY',
    );
    // 方案曾误写 'row'；DSH 实际取值为 'single' | 'per-record'，此处固化契约
    expectTdaError(
      () =>
        defineTdaDomain({
          name: 'ok',
          version: 1,
          tables: { goals: GoalSchema },
          layout: 'row' as never,
        }),
      'INVALID_LAYOUT',
    );
  });

  it('合法规格原样返回', () => {
    const spec = defineTdaDomain({
      name: 'ok',
      version: 0,
      tables: { goals: GoalSchema },
      layout: 'per-record',
    });
    expect(spec.name).toBe('ok');
    expect(spec.layout).toBe('per-record');
  });
});

describe('invalidRecords 分级', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('tda-kernel-inv-');
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  const writeUnitFile = async (name: string, records: Record<string, unknown>): Promise<void> => {
    await writeFile(join(dir, `${name}.json`), JSON.stringify({ version: 1, records }), 'utf8');
  };

  const validRecord = { id: 'goal-1', title: '有效', revision: 0 };
  const corruptRecord = { id: 'goal-2', title: 123, revision: 0 };

  it('reject（缺省）：权威记录损坏即整域拒绝打开', async () => {
    await writeUnitFile('smoke-goals', {
      'goals\u0000goal-1': validRecord,
      'goals\u0000goal-2': corruptRecord,
    });
    const backend = createJsonBackend(dir);
    await expectTdaErrorAsync(() => openTdaDomain(goalSpec, { backend }), 'INVALID_RECORD');
  });

  it('backup-and-skip：派生记录损坏即备份移出并跳过', async () => {
    await writeUnitFile('smoke-goals', {
      'goals\u0000goal-1': validRecord,
      'goals\u0000goal-2': corruptRecord,
    });
    const invalid: string[] = [];
    const backend = createJsonBackend(dir);
    const domain = await openTdaDomain(
      defineTdaDomain({
        name: 'smoke-goals',
        version: 1,
        tables: { goals: GoalSchema },
        invalidRecords: 'backup-and-skip',
      }),
      {
        backend,
        onInvalidRecord: (info) => invalid.push(`${info.table}/${info.key}`),
      },
    );
    const goals = domain.table('goals');
    expect(goals.size()).toBe(1);
    expect(goals.get('goal-1')?.title).toBe('有效');
    expect(invalid).toEqual(['goals/goal-2']);

    // 损坏记录已移出主存储、进入备份文件
    const main = JSON.parse(await readFile(join(dir, 'smoke-goals.json'), 'utf8')) as {
      records: Record<string, unknown>;
    };
    expect(Object.keys(main.records)).toEqual(['goals\u0000goal-1']);
    const backup = JSON.parse(await readFile(join(dir, 'smoke-goals.backup.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(backup)).toEqual(['goals\u0000goal-2']);

    await domain.close();
    await backend.close();
  });
});

describe('CAS：期望 revision 不匹配即抛，不静默重试', () => {
  const base = { id: 'goal-1', title: '目标', revision: 0 };

  it('匹配：应用变更并递增 revision', () => {
    const next = cas(base, 0, (current) => ({ id: current.id, title: '改后' }));
    expect(next).toEqual({ id: 'goal-1', title: '改后', revision: 1 });
  });

  it('不匹配：抛 STALE_REVISION 且 mutate 未被调用', () => {
    const mutate = vi.fn((current: typeof base) => ({ id: current.id, title: '不应生效' }));
    try {
      cas({ ...base, revision: 3 }, 0, mutate);
      throw new Error('期望抛出 StaleRevisionError，但未抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(StaleRevisionError);
      expect((error as StaleRevisionError).code).toBe('STALE_REVISION');
      expect((error as StaleRevisionError).expected).toBe(0);
      expect((error as StaleRevisionError).actual).toBe(3);
    }
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('allocateId：无洞 id 分配', () => {
  it('空表从 1 开始，随键增长', () => {
    const table = new Map<string, unknown>();
    expect(allocateId(table, 'goal')).toBe('goal-1');
    table.set('goal-1', {});
    expect(allocateId(table, 'goal')).toBe('goal-2');
    table.set('goal-2', {});
    expect(allocateId(table, 'goal')).toBe('goal-3');
  });

  it('忽略异前缀与非法后缀', () => {
    const table = new Map<string, unknown>([
      ['task-9', {}],
      ['goal-x', {}],
      ['goal-', {}],
      ['other-1', {}],
    ]);
    expect(allocateId(table, 'goal')).toBe('goal-1');
  });

  it('崩溃重开后延续（分配即落键，无独立计数器）', async () => {
    const dir = await makeTempDir('tda-kernel-id-');
    try {
      const spec = defineTdaDomain({ name: 'id-domain', version: 1, tables: { goals: GoalSchema } });

      let backend = createJsonBackend(dir);
      let domain = await openTdaDomain(spec, { backend });
      const goals = domain.table('goals');
      const id1 = allocateId(goals, 'goal');
      await goals.put(id1, { id: id1, title: '一', revision: 0 });
      await domain.close();
      await backend.close();

      backend = createJsonBackend(dir);
      domain = await openTdaDomain(spec, { backend });
      const id2 = allocateId(domain.table('goals'), 'goal');
      expect(id2).toBe('goal-2');
      await domain.close();
      await backend.close();
    } finally {
      await removeTempDir(dir);
    }
  });

  it('数值空间耗尽即抛', () => {
    const table = new Map<string, unknown>([['goal-9007199254740991', {}]]);
    expect(() => allocateId(table, 'goal')).toThrow(IdSpaceExhaustedError);
  });
});

describe('内核不变量：漏双写即违规', () => {
  it('域直写不过双写器 → reconcile 报漏双写 → 注册的检查 fail', async () => {
    const dir = await makeTempDir('tda-kernel-dw-');
    try {
      const backend = createJsonBackend(dir);
      const reconciler = createDualWriteReconciler();
      const domain = await openTdaDomain(goalSpec, {
        backend,
        onChange: (change) =>
          reconciler.observeChange({
            domain: change.domain,
            table: change.table,
            key: change.key,
            operation: change.operation,
          }),
      });
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, reconciler);

      // 直写域（绕过双写器）——漏双写
      await domain.table('goals').put('goal-1', { id: 'goal-1', title: '漏网', revision: 0 });

      const report = reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges).toHaveLength(1);

      await expect(registry.verify(TDA_KERNEL_PACKAGE)).rejects.toThrow(InvariantError);

      await domain.close();
      await backend.close();
    } finally {
      await removeTempDir(dir);
    }
  });

  it('全部经双写器 → 检查通过', async () => {
    const dir = await makeTempDir('tda-kernel-dw-');
    try {
      const backend = createJsonBackend(dir);
      const reconciler = createDualWriteReconciler();
      const domain = await openTdaDomain(goalSpec, {
        backend,
        onChange: (change) =>
          reconciler.observeChange({
            domain: change.domain,
            table: change.table,
            key: change.key,
            operation: change.operation,
          }),
      });
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, reconciler);
      const { sink } = createMemorySink();
      const goals = domain.table('goals');

      await dualWrite(
        sink,
        {
          family: 'goalTree/change',
          businessId: 'goal-1',
          payload: { title: '合规一' },
          domainWrite: () => goals.put('goal-1', { id: 'goal-1', title: '合规一', revision: 0 }),
        },
        { reconciler },
      );
      await dualWrite(
        sink,
        {
          family: 'goalTree/change',
          businessId: 'goal-2',
          payload: { title: '合规二' },
          domainWrite: () => goals.put('goal-2', { id: 'goal-2', title: '合规二', revision: 0 }),
        },
        { reconciler },
      );

      await expect(registry.verify(TDA_KERNEL_PACKAGE)).resolves.toBeUndefined();

      await domain.close();
      await backend.close();
    } finally {
      await removeTempDir(dir);
    }
  });

  it('多插件共用一个 registry：同包名只注册一次，且覆盖全部对账器', async () => {
    const dir = await makeTempDir('tda-kernel-multi-');
    try {
      const backend = createJsonBackend(dir);
      // 两个插件各自的域与对账器（模拟装配层把两插件装到同一 ctx.invariants）
      const reconcilerA = createDualWriteReconciler();
      const reconcilerB = createDualWriteReconciler();
      const domainA = await openTdaDomain(goalSpec, {
        backend,
        onChange: (change) =>
          reconcilerA.observeChange({
            domain: change.domain,
            table: change.table,
            key: change.key,
            operation: change.operation,
          }),
      });
      const domainB = await openTdaDomain(goalSpec, {
        backend,
        onChange: (change) =>
          reconcilerB.observeChange({
            domain: change.domain,
            table: change.table,
            key: change.key,
            operation: change.operation,
          }),
      });
      const registry = createTdaInvariantRegistry();

      // 第二次注册不得抛 DUPLICATE_INVARIANT_PACKAGE
      const offA = registerTdaInvariants(registry, reconcilerA);
      const offB = registerTdaInvariants(registry, reconcilerB);

      // 插件 B 直写域（绕过双写器）→ 内核门须在聚合后捕获
      await domainB.table('goals').put('goal-b', { id: 'goal-b', title: 'B 漏网', revision: 0 });
      expect(reconcilerA.reconcile().ok).toBe(true);
      expect(reconcilerB.reconcile().ok).toBe(false);
      await expect(registry.verify(TDA_KERNEL_PACKAGE)).rejects.toThrow(InvariantError);

      await domainA.close();
      await domainB.close();

      // 退订只摘自己：A 退订后 B 仍在检查内
      offA();
      expect(reconcilerB.reconcile().ok).toBe(false);
      await expect(registry.verify(TDA_KERNEL_PACKAGE)).rejects.toThrow(InvariantError);
      // 末位退订后包名注册整体注销（可重新干净注册）
      offB();
      await expect(registry.verify(TDA_KERNEL_PACKAGE)).resolves.toBeUndefined();
      expect(() => registerTdaInvariants(registry, createDualWriteReconciler())).not.toThrow();

      await backend.close();
    } finally {
      await removeTempDir(dir);
    }
  });

  it('原子发布串行化：并发写同一 unit 不踩 tmp，末态完整可读', async () => {
    const dir = await makeTempDir('tda-kernel-race-');
    try {
      const backend = createJsonBackend(dir);
      const unit = backend.open({ name: 'race', version: 1 });
      const total = 24;

      // 并发 putRecord：flush 未串行时并发写同一 <name>.json.tmp
      // （Windows 得 EPERM；POSIX 上更隐蔽——rename 可能搬走半份 tmp）
      await Promise.all(
        Array.from({ length: total }, (_, index) => unit.putRecord(`k-${String(index).padStart(2, '0')}`, { index })),
      );
      await unit.close();

      // 换一个 backend 重新装载：读的是 rename 后的主文件，末态须完整
      const reopened = createJsonBackend(dir);
      const again = reopened.open({ name: 'race', version: 1 });
      const loaded = await again.loadAll();
      expect(loaded.size).toBe(total);
      for (let index = 0; index < total; index += 1) {
        expect(loaded.get(`k-${String(index).padStart(2, '0')}`)).toEqual({ index });
      }
      await reopened.close();
    } finally {
      await removeTempDir(dir);
    }
  });
});
