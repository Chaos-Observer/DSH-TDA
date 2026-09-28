/** T3.4 门：红队 run / 发现闭环 / Gate 阻断 / env 守卫 / 零泄漏 / 矩阵 / 确定性。 */
import { describe, expect, it } from 'vitest';
import { createSecurityService } from '../src/service.ts';
import { openTdaDomain } from '@tda/kernel';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, fixtureText, fixtureHash } from './helpers.ts';

describe('T3.4 security 门', () => {
  it('1. 红队 run 全 blocked：零 finding + Gate 绿；五实例一致（memory 载荷×5 实例）', async () => {
    const fx = await setup();
    try {
      const run = await fx.service.run('injection-redteam');
      expect(run.status).toBe('reported');
      expect(run.results.every((result) => result.actual === 'blocked')).toBe(true);
      expect(fx.service.findings().length).toBe(0);
      expect(fx.service.gateBlocked()).toBe(false);
      // J6 五实例一致：injection-memory 用例按 5 实例遍跑
      const memoryProbes = fx.probeCalls.filter((call) => call.caseId === 'rtc-1');
      expect(memoryProbes.length).toBe(5);
      expect(new Set(memoryProbes.map((call) => call.instance)).size).toBe(5);
    } finally {
      await fx.dispose();
    }
  });

  it('2. breached ⇒ critical finding open ⇒ Gate 红灯（阻断可证）', async () => {
    const fx = await setup();
    try {
      fx.setVerdict('breached');
      const run = await fx.service.run('injection-redteam');
      expect(run.results.some((result) => result.actual === 'breached')).toBe(true);
      const open = fx.service.findings('open');
      expect(open.length).toBeGreaterThan(0);
      expect(fx.service.gateBlocked()).toBe(true);
    } finally {
      await fx.dispose();
    }
  });

  it('3. 修复闭环：fixed 强制 regressionRunId（指向该 case passed 的 run）+ fixSpecRef', async () => {
    const fx = await setup();
    try {
      fx.setVerdict('breached');
      const run = await fx.service.run('injection-redteam', ['rtc-1']);
      const openFindings = fx.service.findings('open');
      expect(openFindings.length).toBe(5); // 五实例各开一个 finding
      await expect(
        fx.service.updateFinding(String(openFindings[0]!.findingId), { status: 'fixed' }),
      ).rejects.toMatchObject({ code: 'SECURITY_REGRESSION_REQUIRED' });
      // 修复后回归：该 case 判 blocked
      fx.setVerdict('blocked');
      const regression = await fx.service.run('injection-redteam', ['rtc-1']);
      await expect(
        fx.service.updateFinding(String(openFindings[0]!.findingId), { status: 'fixed', regressionRunId: 'rtr-404', fixSpecRef: 'T1.1/INV-gate' }),
      ).rejects.toMatchObject({ code: 'SECURITY_REGRESSION_NOT_FOUND' });
      for (const finding of openFindings) {
        const fixed = await fx.service.updateFinding(String(finding.findingId), {
          status: 'fixed',
          regressionRunId: String(regression.runId),
          fixSpecRef: 'T1.1/INV-gate',
        });
        expect(fixed.status).toBe('fixed');
      }
      expect(fx.service.gateBlocked()).toBe(false);
      void run;
    } finally {
      await fx.dispose();
    }
  });

  it('4. risk-accepted 显式化：四要素缺一即拒；齐备后不计 open', async () => {
    const fx = await setup();
    try {
      fx.setVerdict('breached');
      await fx.service.run('injection-redteam', ['rtc-10']);
      const finding = fx.service.findings('open')[0]!;
      await expect(
        fx.service.acceptRisk(String(finding.findingId), { reason: '', scope: 'ci', tokenRef: 'apr-1', reviewAt: 1 }),
      ).rejects.toMatchObject({ code: 'SECURITY_ACCEPTANCE_INCOMPLETE' });
      const accepted = await fx.service.acceptRisk(String(finding.findingId), {
        reason: 'CI-only 面，主链路不触达',
        scope: 'ci-mock',
        tokenRef: 'apr-1',
        reviewAt: 1,
      });
      expect(accepted.status).toBe('risk-accepted');
      expect(fx.service.gateBlocked()).toBe(false);
    } finally {
      await fx.dispose();
    }
  });

  it('5. env 守卫：非 ci-mock 构造即抛（红队不进生产运行时）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-sec-env-'));
    const backend = await openTdaDomain;
    void backend;
    const domain = await (await import('../src/service.ts')).createSecurityService;
    void domain;
    const kernel = await import('@tda/kernel');
    const dom = await kernel.openTdaDomain((await import('../src/domain.ts')).securityDomainSpec, {
      backend: kernel.createJsonBackend(dir),
    });
    expect(() =>
      createSecurityService({
        domain: dom,
        session: { sessionId: 's' as never, append: () => 1, flush() {} },
        executor: { async probe() { return 'blocked' as const; } },
        env: 'production' as never,
        now: () => 0,
      }),
    ).toThrowError(/ci-mock/);
    await dom.close();
  });

  it('6. 载荷零泄漏：run/finding 记录不含 fixture 正文（J9 grep 自检）', async () => {
    const fx = await setup();
    try {
      fx.setVerdict('breached');
      await fx.service.run('injection-redteam');
      const dump = JSON.stringify([
        ...fx.domain.table('redteam_runs').entries(),
        ...fx.domain.table('security_findings').entries(),
        ...fx.domain.table('redteam_cases').entries(),
      ]);
      expect(dump).not.toContain(fixtureText('sleeper-payload.txt').split('\n')[0]!.slice(0, 20));
      expect(dump).toContain(fixtureHash('sleeper-payload.txt').slice(0, 24));
    } finally {
      await fx.dispose();
    }
  });

  it('7. 对账矩阵：全用例齐 ⇒ 五条款全 covered；matrix-check run 零缺口', async () => {
    const fx = await setup();
    try {
      const matrix = fx.service.matrix();
      expect(matrix.length).toBe(5);
      expect(matrix.every((row) => row.covered)).toBe(true);
      const run = await fx.service.run('matrix-check');
      expect(run.status).toBe('reported');
    } finally {
      await fx.dispose();
    }
  });

  it('8. 确定性：同 fixture+params ⇒ 两次 run verdict 逐位相等（不变量 2/9）', async () => {
    const fx = await setup();
    try {
      const runA = await fx.service.run('penetration');
      const runB = await fx.service.run('penetration');
      expect(runA.results.map((result) => result.actual)).toEqual(runB.results.map((result) => result.actual));
    } finally {
      await fx.dispose();
    }
  });
});
