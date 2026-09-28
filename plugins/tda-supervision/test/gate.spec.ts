/** T3.2 冒烟门：审批链路 / token 防重放 / 显式终态 / 计量三区 / 元规则 / 洪水帽 / 仪表盘。 */
import { describe, expect, it } from 'vitest';
import { NOW, baseInput, setup } from './helpers.ts';

describe('T3.2 supervision 冒烟门', () => {
  it('1. G3-② 审批链路：request→定级 high→token→approve→ResumeTicket；重复消费拒绝', async () => {
    const fx = await setup();
    try {
      const approval = await fx.service.request(baseInput());
      expect(approval.riskLevel).toBe('high');
      expect(approval.status).toBe('pending');
      expect(approval.token.nonce).not.toBe('');
      const ticket = await fx.service.approve(String(approval.approvalId), approval.token.nonce);
      expect(ticket.approvalId).toBe(String(approval.approvalId));
      expect(ticket.handle).toBe('order-dp-1');
      // token 不匹配：拿 a1 的 nonce 打 a2 → 拒绝（防重放）
      const a2 = await fx.service.request(baseInput({ requester: { service: 'test', ref: 'req-2' } }));
      await expect(fx.service.approve(String(a2.approvalId), approval.token.nonce)).rejects.toMatchObject({
        code: 'SUPERVISION_TOKEN_MISMATCH',
      });
      // 一次性：apr-1 已 approved，重复 approve 拒绝且 resolution 已焚 token
      await expect(fx.service.approve(String(approval.approvalId), approval.token.nonce)).rejects.toMatchObject({
        code: 'SUPERVISION_NOT_PENDING',
      });
      expect(fx.service.pending().length).toBe(1);
      // 事件链 + 审计索引可回放
      const kinds = fx.service.events().map((event) => event.kind);
      expect(kinds).toContain('requested');
      expect(kinds).toContain('token-issued');
      expect(kinds).toContain('approved');
      expect(kinds).toContain('attention-charged');
    } finally {
      await fx.dispose();
    }
  });

  it('2. token 过期回 pending（无自动 resolved）；重签后可用', async () => {
    let now = NOW;
    const fx = await setup({ now: () => now });
    try {
      const approval = await fx.service.request(baseInput());
      now += 25 * 3_600_000; // 越过 24h TTL
      await expect(fx.service.approve(String(approval.approvalId), approval.token.nonce)).rejects.toMatchObject({
        code: 'SUPERVISION_TOKEN_EXPIRED',
      });
      // 状态仍是 pending（过期 ≠ resolved，J4）
      expect(fx.service.pending().length).toBe(1);
      const reissued = await fx.service.reissueToken(String(approval.approvalId));
      const ticket = await fx.service.approve(String(approval.approvalId), reissued.token.nonce);
      expect(ticket.from).toBe('starting');
    } finally {
      await fx.dispose();
    }
  });

  it('3. reject 显式终态必带 note；cancel 必带 reason', async () => {
    const fx = await setup();
    try {
      const a1 = await fx.service.request(baseInput({ requester: { service: 'test', ref: 'r1' } }));
      const rejected = await fx.service.reject(String(a1.approvalId), a1.token.nonce, '设备不在手边');
      expect(rejected.status).toBe('rejected');
      expect(rejected.statusReason).toBe('设备不在手边');
      const a2 = await fx.service.request(baseInput({ requester: { service: 'test', ref: 'r2' } }));
      await expect(fx.service.cancel(String(a2.approvalId), '')).rejects.toMatchObject({ code: 'SUPERVISION_REASON_REQUIRED' });
      const cancelled = await fx.service.cancel(String(a2.approvalId), '任务已取消');
      expect(cancelled.status).toBe('cancelled');
    } finally {
      await fx.dispose();
    }
  });

  it('4. 计量三区：units 复算；压力区 low 转 digest、flush 聚合计费；exhausted 告警', async () => {
    let now = NOW;
    const fx = await setup({ now: () => now });
    try {
      // high 逐项：units=5×1
      const high = await fx.service.request(baseInput());
      expect(high.attention.units).toBe(5);
      // 压缩配额到 6 → 已耗 5 = 83% 压力区
      await fx.service.setParams({ attentionQuotaUnits: 6 });
      const low = await fx.service.request(
        baseInput({
          kind: 'adoption-candidate' as never,
          whatToShow: {
            summary: '插件候选呈现',
            impact: [{ target: 'registry', change: 'create' as const, reversible: true }],
            riskReasons: [],
            evidence: [],
          },
          requester: { service: 'scout', ref: 's1' },
          resume: { from: 'digest', handle: 'adopt' },
        }),
      );
      expect(low.riskLevel).toBe('low');
      // 压力区 low 入 digest（不即时计费）
      const digest = fx.service.digest();
      expect(digest.items.some((item) => item.approvalId === String(low.approvalId))).toBe(true);
      const before = fx.service.attentionStatus();
      expect(before.zone).toBe('pressure');
      // flush 聚合计费
      const flushed = await fx.service.flushDigest();
      expect(flushed.pendingUnits).toBe(low.attention.units);
      expect(fx.service.attentionStatus().consumedUnits).toBe(5 + low.attention.units);
      // veto：可逆项可否决（先重新造一个 digest 项：exhausted 后 medium 入 digest）
      const medium = await fx.service.request(
        baseInput({
          kind: 'workflow-node' as never,
          whatToShow: {
            summary: '工作流节点',
            impact: [{ target: 'run', change: 'update' as const, reversible: true }],
            riskReasons: [],
            evidence: [],
          },
          requester: { service: 'workflow', ref: 'w1' },
          resume: { from: 'awaiting-approval', handle: 'h1' },
        }),
      );
      expect(fx.service.digest().items.some((item) => item.approvalId === String(medium.approvalId))).toBe(true);
      await fx.service.veto(String(medium.approvalId), '方案变更');
      expect(fx.service.digest().items.length).toBe(0);
    } finally {
      await fx.dispose();
    }
  });

  it('5. 元规则：不可逆动作最低 high（调用方低档被服务端抬升）', async () => {
    const fx = await setup();
    try {
      const approval = await fx.service.request(
        baseInput({
          kind: 'adoption-candidate' as never,
          whatToShow: {
            summary: '含不可逆影响',
            impact: [{ target: 'asset', change: 'invalidate' as const, reversible: false }],
            riskReasons: ['irreversible'],
            evidence: [],
          },
          requester: { service: 'maintenance', ref: 'm1' },
          resume: { from: 'x', handle: 'h' },
        }),
      );
      expect(approval.riskLevel).toBe('high');
    } finally {
      await fx.dispose();
    }
  });

  it('6. 洪水帽：超 requestRateLimitPerHour 即拒绝', async () => {
    const fx = await setup();
    try {
      await fx.service.setParams({ requestRateLimitPerHour: 2 });
      await fx.service.request(baseInput({ requester: { service: 't', ref: '1' } }));
      await fx.service.request(baseInput({ requester: { service: 't', ref: '2' } }));
      await expect(fx.service.request(baseInput({ requester: { service: 't', ref: '3' } }))).rejects.toMatchObject({
        code: 'SUPERVISION_RATE_LIMIT',
      });
    } finally {
      await fx.dispose();
    }
  });

  it('7. 仪表盘只读聚合 + pending 查询面', async () => {
    const fx = await setup();
    try {
      await fx.service.request(baseInput());
      const dash = fx.service.dashboard({ from: 0, to: NOW + 1 });
      expect(dash.approvalsByRisk.high).toBe(1);
      expect(dash.pendingDepth).toBe(1);
      const status = fx.service.attentionStatus();
      expect(status.consumedUnits).toBe(5);
      expect(status.zone).toBe('normal');
    } finally {
      await fx.dispose();
    }
  });
});
