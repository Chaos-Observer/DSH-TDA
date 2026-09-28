/**
 * tda-skill-registry 不变量门（门2）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createJsonBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
} from '@tda/kernel';
import { skillDomainSpec } from '../src/domain.ts';
import { registerSkillInvariants, skillInvariantChecks } from '../src/loadChecks.ts';
import { draftOf, setup, type SkillFixture } from './helpers.ts';

describe('T2.2 不变量门', () => {
  it('skill-params-singleton：缺行红（initialize 未跑即注册）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-skill-inv-'));
    const backend = createJsonBackend(dir);
    const domain = await openTdaDomain(skillDomainSpec, { backend });
    try {
      const registry = createTdaInvariantRegistry();
      const unregister = registerSkillInvariants(registry, domain, {});
      await expect(registry.verify('tda-skill-registry')).rejects.toThrowError(/必须恰有一行/);
      unregister();
    } finally {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('真实服务全流程后 verify 绿（无误报）', async () => {
    const fx: SkillFixture = await setup();
    try {
      const skill = await fx.service.propose({ actor: 'human', sessionId: 's' }, draftOf('inv-skill'));
      await fx.service.rehearse({ actor: 'human', sessionId: 's' }, String(skill.id), 'task-1');
      await fx.service.logUse({ actor: 'human', sessionId: 's' }, String(skill.id), 'task-2', 'success');
      const registry = createTdaInvariantRegistry();
      const unregister = registerSkillInvariants(registry, fx.domain, { service: fx.service });
      await expect(registry.verify('tda-skill-registry')).resolves.toBeUndefined();
      unregister();
    } finally {
      await fx.dispose();
    }
  });

  it('skill-service-no-lifecycle-face：出现生命周期写方法红', async () => {
    const fx = await setup();
    try {
      const fake = { setLifecycle: async () => undefined } as unknown as typeof fx.service;
      const registry = createTdaInvariantRegistry();
      const unregister = registerSkillInvariants(registry, fx.domain, { service: fake });
      await expect(registry.verify('tda-skill-registry')).rejects.toThrowError(/生命周期写方法 setLifecycle/);
      unregister();
    } finally {
      await fx.dispose();
    }
  });

  it('检查清单与规格映射一一对应（防静默删检查）', async () => {
    const fx = await setup();
    try {
      const names = skillInvariantChecks(fx.domain, { service: fx.service }).map((check) => check.name);
      expect(names).toEqual([
        'skill-params-singleton',
        'skill-steps-whitelist',
        'skill-usage-elo-replayable',
        'skill-service-no-lifecycle-face',
      ]);
    } finally {
      await fx.dispose();
    }
  });
});
