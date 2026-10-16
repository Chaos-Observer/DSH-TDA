/** T4.4 门 2：HTTP 传输面（路由白名单/方法白名单/bind fail-loud/页面静态/自恢复）。 */
import { describe, expect, it } from 'vitest';
import { PAGE_HTML } from '../src/service.ts';
import { NOW, setup, type Rig } from './helpers.ts';

/** fetch 助手（Node 22 内置；返回 status 与响应体）。 */
const get = async (url: string, init?: RequestInit): Promise<{ status: number; body: string; type: string }> => {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.text(), type: response.headers.get('content-type') ?? '' };
};

/** 起服务器 + 用毕即关（ephemeral 端口，并行安全）。 */
async function withServer(rig: Rig, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const { url } = await rig.handle.service.startServer({ port: 0 });
  try {
    await run(url);
  } finally {
    await rig.handle.service.stopServer();
  }
}

describe('T4.4 HTTP 安全三纪律', () => {
  it('bind 非 loopback 一律拒绝（不变量 2 fail-loud）', async () => {
    const rig = await setup();
    try {
      expect(() => rig.handle.service.startServer({ host: '0.0.0.0' })).toThrowError(/loopback/);
      expect(() => rig.handle.service.startServer({ host: '192.168.1.5' })).toThrowError(/loopback/);
      expect(rig.handle.service.serverStatus().listening).toBe(false);
    } finally {
      await rig.dispose();
    }
  });

  it('路由白名单外 404；非 GET 方法 405（不变量 3：写路由不存在）', async () => {
    const rig = await setup();
    try {
      await withServer(rig, async (base) => {
        expect((await get(`${base}/nope`)).status).toBe(404);
        expect((await get(`${base}/api/anything`)).status).toBe(404);
        const post = await get(`${base}/api/snapshot`, { method: 'POST', body: '{}' });
        expect(post.status).toBe(405);
        expect(post.body).toBe('');
        const del = await fetch(`${base}/api/report`, { method: 'DELETE' });
        expect(del.status).toBe(405);
        expect(del.headers.get('allow')).toBe('GET');
      });
    } finally {
      await rig.dispose();
    }
  });

  it('页面静态零动态数据 + 路由全表可达（J5/J8）', async () => {
    const rig = await setup();
    try {
      await withServer(rig, async (base) => {
        const page = await get(`${base}/`);
        expect(page.status).toBe(200);
        expect(page.type).toContain('text/html');
        expect(page.body).toBe(PAGE_HTML);
        // 静态页面不内嵌任何权威域数据（数据只走 /api/snapshot）
        expect(page.body).not.toContain('goal-1');
        expect(page.body).not.toContain('整理灯环协议依赖清单');
        expect((await get(`${base}/api/health`)).status).toBe(200);
        const snap = await get(`${base}/api/snapshot`);
        expect(snap.status).toBe(200);
        expect(JSON.parse(snap.body)).toHaveProperty('spectrum');
        expect((await get(`${base}/api/report`)).type).toContain('text/markdown');
        expect((await get(`${base}/api/export/dot`)).body).toContain('digraph taskgraph');
        expect(JSON.parse((await get(`${base}/api/export/json`)).body)).toHaveProperty('goals');
      });
    } finally {
      await rig.dispose();
    }
  });

  it('stopServer 后自恢复（J9/验收 10：无状态重启）', async () => {
    const rig = await setup();
    try {
      await withServer(rig, async (base) => {
        expect((await get(`${base}/api/health`)).status).toBe(200);
      });
      expect(rig.handle.service.serverStatus().listening).toBe(false);
      await withServer(rig, async (base2) => {
        const health = await get(`${base2}/api/health`);
        expect(health.status).toBe(200);
        expect(JSON.parse(health.body).version).toBe('0.1.0');
      });
    } finally {
      await rig.dispose();
    }
  });

  it('serverStatus 端口回传（默认 7391 / ephemeral=0）', async () => {
    const rig = await setup();
    try {
      expect(rig.handle.service.serverStatus().listening).toBe(false);
      const { url, port } = await rig.handle.service.startServer({ port: 0 });
      expect(url).toContain('127.0.0.1');
      expect(port).toBeGreaterThan(0);
      expect(rig.handle.service.serverStatus().listening).toBe(true);
      expect(rig.handle.service.serverStatus().port).toBe(port);
      await rig.handle.service.stopServer();
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.4 HTTP × 权威域一致性（不变量 6）', () => {
  it('/api/snapshot 与 service.snapshot() 逐字段一致', async () => {
    const rig = await setup();
    try {
      await withServer(rig, async (base) => {
        const httpSnap = JSON.parse((await get(`${base}/api/snapshot`)).body) as { at: number };
        const direct = rig.handle.service.snapshot();
        expect(httpSnap.at).toBe(direct.at);
        expect(httpSnap).toEqual(direct);
      });
      void NOW;
    } finally {
      await rig.dispose();
    }
  });
});
