/**
 * tda-executor 不变量门（门2 test:invariants）。
 *
 * 覆盖：① schema 拒载（注毒记录 ⇒ openTdaDomain 抛 reject）；② 加载期检查
 * （正常域通过 + 违规用例）；③ boot 前在飞 attempt 的 initialize 收口。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asAttemptId,
  compositeRecordKey,
  createJsonBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
  type TdaKvUnit,
} from '@tda/kernel';
import { executorDomainSpec, EXECUTOR_PARAMS_KEY } from '../src/domain.ts';
import { registerExecutorInvariants } from '../src/loadChecks.ts';
import { makeTask, NOW, setup } from './helpers.ts';

async function openPoisoned(poison: (unit: TdaKvUnit) => Promise<void>): Promise<Error> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-executor-inv-'));
  const backend = createJsonBackend(dir);
  const unit = await backend.open({ name: executorDomainSpec.name, version: executorDomainSpec.version });
  await poison(unit);
  await unit.close();
  try {
    await openTdaDomain(executorDomainSpec, { backend });
    throw new Error('UNEXPECTED_OPEN_SUCCESS');
  } catch (error) {
    return error as Error;
  } finally {
    await backend.close();
    spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' })
      .on('error', () => undefined)
      .unref();
  }
}

describe('T4.1 schema 拒载（invalidRecords=reject）', () => {
  it('注毒 attempt：failed 无 unfinished ⇒ 拒绝打开', async () => {
    const error = await openPoisoned(async (unit) => {
      await unit.putRecord(compositeRecordKey('executor_attempts', 'exec-1'), {
        id: 'exec-1',
        revision: 3,
        taskId: 'task-1',
        goalId: 'goal-1',
        mode: 'dispatch',
        modeReason: 'no-def',
        status: 'failed',
        attempts: 1,
        ownerId: 'sess-harness-scheduler',
        createdAt: NOW,
        settledAt: NOW,
        // 缺 unfinished：违反 superRefine（C5 显式终态）
      });
    });
    expect(error.message).not.toBe('UNEXPECTED_OPEN_SUCCESS');
    expect(error.message).toContain('unfinished');
  });

  it('注毒 attempt：attempts=0 ⇒ 拒绝打开', async () => {
    const error = await openPoisoned(async (unit) => {
      await unit.putRecord(compositeRecordKey('executor_attempts', 'exec-1'), {
        id: 'exec-1',
        revision: 3,
        taskId: 'task-1',
        goalId: 'goal-1',
        mode: 'direct',
        modeReason: 'verify-closeout',
        status: 'completed',
        attempts: 0,
        ownerId: 'sess-harness-scheduler',
        outcome: 'success',
        createdAt: NOW,
        settledAt: NOW,
      });
    });
    expect(error.message).toContain('attempts');
  });

  it('注毒 attempt：awaiting-approval 无 approvalId ⇒ 拒绝打开', async () => {
    const error = await openPoisoned(async (unit) => {
      await unit.putRecord(compositeRecordKey('executor_attempts', 'exec-1'), {
        id: 'exec-1',
        revision: 2,
        taskId: 'task-1',
        goalId: 'goal-1',
        mode: 'dispatch',
        modeReason: 'no-def',
        orderId: 'disp-1',
        status: 'awaiting-approval',
        attempts: 1,
        ownerId: 'sess-harness-scheduler',
        createdAt: NOW,
      });
    });
    expect(error.message).toContain('approvalId');
  });

  it('注毒 attempt：非终态携 settledAt ⇒ 拒绝打开', async () => {
    const error = await openPoisoned(async (unit) => {
      await unit.putRecord(compositeRecordKey('executor_attempts', 'exec-1'), {
        id: 'exec-1',
        revision: 2,
        taskId: 'task-1',
        goalId: 'goal-1',
        mode: 'dispatch',
        modeReason: 'no-def',
        status: 'executing',
        attempts: 1,
        ownerId: 'sess-harness-scheduler',
        createdAt: NOW,
        settledAt: NOW,
      });
    });
    expect(error.message).toContain('settledAt');
  });

  it('注毒 params：maxParallel=0 ⇒ 拒绝打开', async () => {
    const error = await openPoisoned(async (unit) => {
      await unit.putRecord(compositeRecordKey('executor_params', EXECUTOR_PARAMS_KEY), {
        maxParallel: 0,
        maxRetries: 1,
        selectionPolicy: 'priority-due',
        verifyMode: 'evidence',
        routerVersion: 1,
        revision: 0,
      });
    });
    expect(error.message).toContain('maxParallel');
  });
});

describe('T4.1 加载期检查', () => {
  it('正常域（params 种子后）verify 通过', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      const registry = createTdaInvariantRegistry();
      registerExecutorInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-executor')).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('boot 前在飞 attempt 被 initialize 收口为显式终态（不变量 8）', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      await rig.domain.table('executor_attempts').put('exec-9', {
        id: asAttemptId('exec-9'),
        revision: 4,
        taskId: 'task-1',
        goalId: 'goal-1',
        mode: 'dispatch',
        modeReason: 'no-def',
        orderId: 'disp-9',
        status: 'executing',
        attempts: 1,
        ownerId: 'sess-harness-scheduler',
        createdAt: NOW - 60_000,
      });
      const reconciled = await rig.service.initialize();
      expect(reconciled).toEqual(['exec-9']);
      const attempt = rig.service.attempt('exec-9');
      expect(attempt?.status).toBe('failed');
      expect(attempt?.outcome).toBe('failed');
      expect(attempt?.unfinished?.[0]).toContain('executor-restart');
      expect(attempt?.settledAt).toBeTypeOf('number');
    } finally {
      await rig.dispose();
    }
  });

  it('attempts 超重试帽 verify 红', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      await rig.domain.table('executor_attempts').put('exec-8', {
        id: asAttemptId('exec-8'),
        revision: 5,
        taskId: 'task-1',
        goalId: 'goal-1',
        mode: 'dispatch',
        modeReason: 'no-def',
        orderId: 'disp-8',
        status: 'failed',
        attempts: 3, // maxRetries=1 ⇒ 帽 2
        ownerId: 'sess-harness-scheduler',
        outcome: 'failed',
        unfinished: ['x'],
        createdAt: NOW,
        settledAt: NOW,
      });
      const registry = createTdaInvariantRegistry();
      registerExecutorInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-executor')).rejects.toThrowError(/超重试帽/);
    } finally {
      await rig.dispose();
    }
  });

  it('服务面携带越权句柄（domain/storage/context/surface）verify 红', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      const rogue = { ...rig.service, domain: {} as never };
      const registry = createTdaInvariantRegistry();
      registerExecutorInvariants(registry, rig.domain, { service: rogue as never });
      await expect(registry.verify('tda-executor')).rejects.toThrowError(/越权句柄/);
      const ok = createTdaInvariantRegistry();
      registerExecutorInvariants(ok, rig.domain, { service: rig.service });
      await expect(ok.verify('tda-executor')).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });
});
