/** P4 集成门 · T4.4 状态台（真运行时聚合 + HTTP 三纪律 + 报告落时间线）。 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleRuntime, type TdaRuntime } from '../src/runtime.ts';

function createClock(start = 1_700_000_000_000): { now: () => number } {
  let current = start;
  return {
    now: () => current,
  };
}

const runtimes: TdaRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

async function setup(options: { displayEnabled?: boolean } = {}): Promise<TdaRuntime> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-harness-p4d-'));
  const clock = createClock();
  const runtime = await assembleRuntime({
    dir,
    now: clock.now,
    ...(options.displayEnabled !== undefined ? { displayEnabled: options.displayEnabled } : {}),
  });
  runtimes.push(runtime);
  return runtime;
}

describe('T4.4 P4 集成门：状态台（功能界面）', () => {
  it('开关默认关：display 不装配（测试环境零端口占用）', async () => {
    const runtime = await setup();
    expect(runtime.display).toBeUndefined();
  });

  it('端到端：建目标→起服务→三路由聚合真数据→报告落时间线→XSS 消毒', async () => {
    const runtime = await setup({ displayEnabled: true });
    expect(runtime.display).toBeDefined();
    // 造真数据：目标 + 任务（经服务面，actor='human' 直建免提议门）
    const goal = await runtime.goalTree.service.create('human', {
      objective: '<script>alert(1)</script>整理协议清单',
      completionCriteria: ['证据：清单落盘'],
      budget: { tokens: 1000 },
    });
    await runtime.taskPool.service.create('human', {
      goalId: goal.id,
      subject: '解析帧定界',
    });

    const display = runtime.display!;
    const { url, port } = await display.service.startServer({ port: 0 });
    expect(url).toContain('127.0.0.1');
    expect(port).toBeGreaterThan(0);

    try {
      // 健康探活
      const health = await fetch(`${url}/api/health`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

      // 页面静态（零动态数据——数据全走 JSON API）
      const page = await (await fetch(`${url}/`)).text();
      expect(page).toContain('树谱');
      expect(page).not.toContain('整理协议清单');

      // 快照与真运行时一致（不变量 6）
      const snapResponse = await fetch(`${url}/api/snapshot`);
      const snap = (await snapResponse.json()) as {
        overview: { goals: { objective: string; taskCount: number }[]; tasks: { ready: number } };
        approvals: unknown[];
        degraded: string[];
      };
      expect(snap.overview.goals).toHaveLength(1);
      expect(snap.overview.goals[0]?.taskCount).toBe(1);
      expect(snap.overview.tasks.ready).toBe(1);
      expect(snap.degraded).toEqual([]);

      // 零写权对账（不变量 1）：快照前后目标 revision 零变化
      const before = runtime.goalTree.service.get(goal.id);
      await display.service.snapshot();
      const after = runtime.goalTree.service.get(goal.id);
      expect(after?.revision).toBe(before?.revision);

      // 导出透传（验收 6）
      const dot = await (await fetch(`${url}/api/export/dot`)).text();
      expect(dot).toContain('digraph');

      // 报告：XSS 被 escape + 落时间线（execution-verified/harness）
      const markdown = await (await fetch(`${url}/api/report`)).text();
      expect(markdown).not.toContain('<script>');
      expect(markdown).toContain('&lt;script&gt;');
      // 新建任务无 outcome ⇒ 证据段显式"无已完成任务"（不虚报）
      expect(markdown).toContain('（无已完成任务）');

      // 非 GET 405 / 未知 404
      expect((await fetch(`${url}/api/snapshot`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${url}/api/nope`)).status).toBe(404);
    } finally {
      await display.service.stopServer();
    }

    // 报告已落时间线（J7；凭证服务端强制）
    const hits = runtime.timeline.service.search({ text: 'TDA 状态报告', mode: 'fts' });
    expect(hits.length).toBeGreaterThan(0);
    const entry = runtime.timeline.service.get(hits[0]!.entry.id);
    expect(entry?.credential).toBe('execution-verified');
    expect(entry?.source).toBe('harness');
  });
});
