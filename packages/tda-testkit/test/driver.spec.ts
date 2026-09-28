/**
 * @tda/testkit 自测：kill -9 三场景驱动闭环。
 *
 * 子进程以 Node 类型剥离直跑（内核 erasable-syntax + 显式 .ts 扩展，零转译依赖），
 * 验证：idle-kill 零差异 / tear-kill 仅允许已知撕裂且零幽灵 / boot-kill 状态原样恢复。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  asSessionId,
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  defineTdaDomain,
  dualWrite,
  openTdaDomain,
  type TdaDomain,
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
} from '../src/index.ts';

const GoalSchema = z.object({ id: z.string(), title: z.string(), revision: z.number() });
const goalSpec = defineTdaDomain({ name: 'kill9-goals', version: 1, tables: { goals: GoalSchema } });

const runtimeDir = fileURLToPath(new URL('../testkit-runtime/', import.meta.url));

/** 子进程公共前导（相对导入本包源码 + 工作区内核），三个场景共用。 */
const SCRIPT_PRELUDE = `
import { z } from 'zod';
import {
  asSessionId,
  createJsonBackend,
  defineTdaDomain,
  dualWrite,
  openTdaDomain,
} from '@tda/kernel';
import { createFileSessionSink, writeControl } from '../src/index.ts';

const dir = process.argv[2];
const controlFile = process.argv[3];
const spec = defineTdaDomain({
  name: 'kill9-goals',
  version: 1,
  tables: { goals: z.object({ id: z.string(), title: z.string(), revision: z.number() }) },
});
const backend = createJsonBackend(dir);
const domain = await openTdaDomain(spec, { backend });
const goals = domain.table('goals');
const sink = createFileSessionSink(dir + '/session.jsonl', asSessionId('sess-scenario'));
`;

/** idle：3 个 op 全部完成后写 idle 并保活，等父进程杀。 */
const IDLE_SCRIPT = `${SCRIPT_PRELUDE}
for (let n = 1; n <= 3; n += 1) {
  writeControl(controlFile, 'ready', n);
  const businessId = 'goal-' + n;
  const record = { id: businessId, title: '目标' + n, revision: 0 };
  await dualWrite(sink, {
    family: 'goalTree/change',
    businessId,
    payload: record,
    domainWrite: () => goals.put(businessId, record),
  });
}
writeControl(controlFile, 'idle');
await domain.close();
await backend.close();
setInterval(() => {}, 1000);
`;

/** tear：第 3 个 op 域已落、事件未落时写 torn 并自杀（确定性撕裂点）。 */
const TEAR_SCRIPT = `${SCRIPT_PRELUDE}
import { hardKillSelf } from '../src/index.ts';
for (let n = 1; n <= 3; n += 1) {
  writeControl(controlFile, 'ready', n);
  const businessId = 'goal-' + n;
  const record = { id: businessId, title: '目标' + n, revision: 0 };
  if (n === 3) {
    await goals.put(businessId, record);
    writeControl(controlFile, 'torn', n);
    hardKillSelf();
  }
  await dualWrite(sink, {
    family: 'goalTree/change',
    businessId,
    payload: record,
    domainWrite: () => goals.put(businessId, record),
  });
}
writeControl(controlFile, 'idle');
await domain.close();
await backend.close();
setInterval(() => {}, 1000);
`;

/** boot：仅打开 domain（触发装载）后写 booted 并保活，不写任何数据。 */
const BOOT_SCRIPT = `${SCRIPT_PRELUDE}
writeControl(controlFile, 'booted');
setInterval(() => {}, 1000);
`;

/** 父进程预置：经双写器落 count 条记录 + 事件日志。 */
async function seedDomain(dir: string, count: number): Promise<void> {
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(goalSpec, { backend });
  const goals = domain.table('goals');
  const sink = createFileSessionSink(join(dir, 'session.jsonl'), asSessionId('sess-seed'));
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  for (let n = 1; n <= count; n += 1) {
    const businessId = `goal-${n}`;
    const record = { id: businessId, title: `种子${n}`, revision: 0 };
    await dualWrite(
      sink,
      {
        family: 'goalTree/change',
        businessId,
        payload: record,
        domainWrite: () => goals.put(businessId, record),
      },
      { reconciler, index },
    );
  }
  await domain.close();
  await backend.close();
}

interface Reopened {
  readonly domain: TdaDomain<{ goals: typeof GoalSchema }>;
  readonly backend: ReturnType<typeof createJsonBackend>;
}

async function reopen(dir: string): Promise<Reopened> {
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(goalSpec, { backend });
  return { domain, backend };
}

describe('kill -9 三场景', () => {
  it('idle-kill：op 全部完成后杀 → log 配对零差异', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-testkit-idle-'));
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

      const { events } = readSessionLog(join(dir, 'session.jsonl'));
      expect(events).toHaveLength(3);

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
    const dir = await mkdtemp(join(tmpdir(), 'tda-testkit-tear-'));
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
      const { events } = readSessionLog(join(dir, 'session.jsonl'));
      expect(events).toHaveLength(2);

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

  it('boot-kill：启动即杀 → 既有状态原样恢复', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-testkit-boot-'));
    try {
      await seedDomain(dir, 3);

      const controlFile = join(dir, 'control.log');
      const spawned = spawnScenario({
        runtimeDir,
        scriptName: 'boot-scenario.mjs',
        scriptSource: BOOT_SCRIPT,
        args: [dir, controlFile],
      });
      expect(await waitForControl(controlFile, 'booted'), spawned.readStderr()).toBe(true);
      const outcome = await killAndWait(spawned.child);
      expect(outcome.hardKilled).toBe(true);

      const { events } = readSessionLog(join(dir, 'session.jsonl'));
      expect(events).toHaveLength(3);

      const { domain, backend } = await reopen(dir);
      try {
        const goals = domain.table('goals');
        expect(goals.size()).toBe(3);
        expect(pairLogAgainstDomain(events, goals.keys()).ok).toBe(true);
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
