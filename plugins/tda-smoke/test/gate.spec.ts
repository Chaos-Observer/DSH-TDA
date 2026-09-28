/**
 * tda-smoke 冒烟门（门4 test:smoke）：IT0 验收载体。
 *
 *  1. 进程内装配：tdaSmokePlugin.apply → 三建一推 → 两级不变量过 → STALE 拒载 → dispose
 *  2. idle-kill：op 全部完成后 kill -9 → log 配对零差异 + replay-equivalence
 *  3. tear-kill：域已落事件未落时自杀 → 仅允许已知撕裂、零幽灵
 *
 * 子进程以 Node 类型剥离直跑（内核 erasable-syntax + 显式 .ts 扩展，零转译依赖），
 * 场景脚本放本包 testkit-runtime/（裸标识符靠 node_modules 向上解析）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  createJsonBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
  StaleRevisionError,
} from '@tda/kernel';
import {
  assertReplayEquivalence,
  compareReplay,
  createFileSessionSink,
  killAndWait,
  pairLogAgainstDomain,
  readSessionLog,
  spawnScenario,
  waitForControl,
} from '@tda/testkit';
import { smokeDomainSpec, tdaSmokePlugin } from '../src/index.ts';

const runtimeDir = fileURLToPath(new URL('../testkit-runtime/', import.meta.url));

/** idle：经插件 service 建 3 个目标，完成后写 idle 保活等杀。 */
const IDLE_SCRIPT = `
import { asSessionId, createJsonBackend, openTdaDomain } from '@tda/kernel';
import { createFileSessionSink, writeControl } from '@tda/testkit';
import { createSmokeService, smokeDomainSpec } from '../src/index.ts';

const dir = process.argv[2];
const controlFile = process.argv[3];
const backend = createJsonBackend(dir);
const domain = await openTdaDomain(smokeDomainSpec, { backend });
const sink = createFileSessionSink(dir + '/session.jsonl', asSessionId('sess-scenario'));
const service = createSmokeService({ domain, session: sink });
writeControl(controlFile, 'ready', 1);
await service.createGoal('目标一');
writeControl(controlFile, 'ready', 2);
await service.createGoal('目标二');
writeControl(controlFile, 'ready', 3);
await service.createGoal('目标三');
writeControl(controlFile, 'idle');
setInterval(() => {}, 1000);
`;

/** tear：service 建 2 个后，绕过双写器直写 goal-3，写 torn 并自杀（确定性撕裂点）。 */
const TEAR_SCRIPT = `
import { asSessionId, createJsonBackend, openTdaDomain } from '@tda/kernel';
import { createFileSessionSink, writeControl, hardKillSelf } from '@tda/testkit';
import { createSmokeService, smokeDomainSpec } from '../src/index.ts';

const dir = process.argv[2];
const controlFile = process.argv[3];
const backend = createJsonBackend(dir);
const domain = await openTdaDomain(smokeDomainSpec, { backend });
const sink = createFileSessionSink(dir + '/session.jsonl', asSessionId('sess-scenario'));
const service = createSmokeService({ domain, session: sink });
await service.createGoal('目标一');
await service.createGoal('目标二');
const goals = domain.table('goals');
await goals.put('goal-3', { id: 'goal-3', title: '撕裂目标', status: 'active', revision: 0 });
writeControl(controlFile, 'torn', 3);
hardKillSelf();
`;

async function reopen(dir: string) {
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(smokeDomainSpec, { backend });
  return { domain, backend };
}

describe('tda-smoke 冒烟门', () => {
  it('进程内装配：apply → 三建一推 → 两级不变量过 → STALE 拒载 → dispose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-smoke-gate-'));
    const registry = createTdaInvariantRegistry();
    const backend = createJsonBackend(dir);
    const handle = await tdaSmokePlugin.apply({
      storage: backend,
      invariants: registry,
      session: createFileSessionSink(join(dir, 'session.jsonl'), asSessionId('sess-gate')),
    });
    try {
      const id1 = await handle.service.createGoal('目标甲');
      await handle.service.createGoal('目标乙');
      await handle.service.createGoal('目标丙');
      await handle.service.completeGoal(id1, 0);
      await expect(registry.verify()).resolves.toBeUndefined();
      // revision 已推进到 1，期望 0 再完成即被 CAS 拒载（不静默重试）
      const error = await handle.service.completeGoal(id1, 0).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(StaleRevisionError);
      expect((error as StaleRevisionError).code).toBe('STALE_REVISION');
    } finally {
      await handle.dispose();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('idle-kill：op 全部完成后 kill -9 → log 配对零差异 + replay 等值', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-smoke-idle-'));
    try {
      const controlFile = join(dir, 'control.log');
      const spawned = spawnScenario({
        runtimeDir,
        scriptName: 'idle-scenario.mjs',
        scriptSource: IDLE_SCRIPT,
        args: [dir, controlFile],
      });
      expect(await waitForControl(controlFile, 'idle'), spawned.readStderr()).toBe(true);
      const outcome = await killAndWait(spawned.child);
      expect(outcome.hardKilled).toBe(true);

      const { events, tornTail } = readSessionLog(join(dir, 'session.jsonl'));
      expect(events).toHaveLength(3);
      expect(tornTail).toBe(false);

      const { domain, backend } = await reopen(dir);
      try {
        const goals = domain.table('goals');
        expect(goals.size()).toBe(3);
        expect(pairLogAgainstDomain(events, goals.keys()).ok).toBe(true);
        assertReplayEquivalence(
          compareReplay(events, goals.entries(), (event) => ({
            key: event.businessId,
            value: event.payload,
          })),
        );
      } finally {
        await domain.close();
        await backend.close();
      }
    } finally {
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('tear-kill：域已落事件未落时自杀 → 仅允许已知撕裂、零幽灵', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-smoke-tear-'));
    try {
      const controlFile = join(dir, 'control.log');
      const spawned = spawnScenario({
        runtimeDir,
        scriptName: 'tear-scenario.mjs',
        scriptSource: TEAR_SCRIPT,
        args: [dir, controlFile],
      });
      expect(await waitForControl(controlFile, 'torn'), spawned.readStderr()).toBe(true);
      const outcome = await killAndWait(spawned.child);
      expect(outcome.hardKilled).toBe(true);

      // op1/op2 事件已提交；op3 域已落、事件撕裂
      const { events, tornTail } = readSessionLog(join(dir, 'session.jsonl'));
      expect(events).toHaveLength(2);
      expect(tornTail).toBe(false);

      const { domain, backend } = await reopen(dir);
      try {
        const goals = domain.table('goals');
        expect(goals.size()).toBe(3);
        const pairing = pairLogAgainstDomain(events, goals.keys());
        expect(pairing.ghosts).toEqual([]);
        expect(pairing.unpaired).toEqual(['goal-3']);
      } finally {
        await domain.close();
        await backend.close();
      }
    } finally {
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
