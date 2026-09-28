/**
 * tda-smoke 不变量门（门2 test:invariants）：两级注册，违规即抛 InvariantError。
 *
 *  - 合法数据：内核级（双写配对）+ 插件级（记录形态）全过
 *  - 插件级违规：键不符合 goal-<n> 约定 → verify('tda-smoke') 抛
 *  - 内核级违规：直写 domain 绕过双写（漏双写）→ verify('@tda/kernel') 抛
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaInvariantRegistry,
  InvariantError,
  openTdaDomain,
  registerTdaInvariants,
  TDA_KERNEL_PACKAGE,
  type TdaDomain,
  type TdaInvariantRegistry,
  type TdaLogEvent,
  type TdaSessionSink,
} from '@tda/kernel';
import { smokeDomainSpec, type SmokeTables } from '../src/domain.ts';
import { createSmokeService, type SmokeService } from '../src/service.ts';
import { registerSmokeInvariants } from '../src/loadChecks.ts';

/** 内存 session sink（与内核单测同构；append 分配自增 seq）。 */
function createMemorySink(): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId('sess-inv'),
    append(event: TdaLogEvent) {
      events.push(event);
      seq += 1;
      return seq;
    },
    flush() {},
    events,
  };
}

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<SmokeTables>;
  readonly registry: TdaInvariantRegistry;
  readonly service: SmokeService;
}

/** 装配一套冒烟插件运行时（域 + 双写对账 + 两级不变量注册 + 服务）。 */
async function assemble(dir: string): Promise<Rig> {
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const registry = createTdaInvariantRegistry();
  const domain = await openTdaDomain(smokeDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  // 两级注册：内核级（@tda/kernel）+ 插件级（tda-smoke）
  registerTdaInvariants(registry, reconciler);
  registerSmokeInvariants(registry, domain);
  const service = createSmokeService({
    domain,
    session: createMemorySink(),
    reconciler,
    index: createAuditIndex(),
  });
  return { dir, backend, domain, registry, service };
}

async function teardown(rig: Rig): Promise<void> {
  await rig.domain.close();
  await rig.backend.close();
  // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', rig.dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

describe('tda-smoke 不变量门', () => {
  it('合法数据：内核级 + 插件级两级不变量全过', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-smoke-inv-ok-')));
    try {
      await rig.service.createGoal('目标甲');
      await rig.service.createGoal('目标乙');
      await expect(rig.registry.verify()).resolves.toBeUndefined();
    } finally {
      await teardown(rig);
    }
  });

  it('插件级违规：键不符合 goal-<n> 约定 → InvariantError', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-smoke-inv-shape-')));
    try {
      // zod 合法但违反插件业务约定（goal- 前缀）
      await rig.domain.table('goals').put('x-1', {
        id: 'x-1',
        title: '坏键目标',
        status: 'active',
        revision: 0,
      });
      await expect(rig.registry.verify('tda-smoke')).rejects.toBeInstanceOf(InvariantError);
      await expect(rig.registry.verify('tda-smoke')).rejects.toThrow(/不符合 goal-/);
    } finally {
      await teardown(rig);
    }
  });

  it('内核级违规：直写 domain 绕过双写 → 漏双写被内核门捕获', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-smoke-inv-leak-')));
    try {
      // 绕过双写器直写权威表：domain 有、事件无
      await rig.domain.table('goals').put('goal-9', {
        id: 'goal-9',
        title: '绕过双写的目标',
        status: 'active',
        revision: 0,
      });
      await expect(rig.registry.verify(TDA_KERNEL_PACKAGE)).rejects.toBeInstanceOf(InvariantError);
      await expect(rig.registry.verify(TDA_KERNEL_PACKAGE)).rejects.toThrow(/漏双写 1 处/);
    } finally {
      await teardown(rig);
    }
  });
});
