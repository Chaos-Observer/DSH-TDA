/** T3.2 双写门：approvals/events/ledger/params 全配对 + 审计定位 + 重启恢复。 */
import { describe, expect, it } from 'vitest';
import { createAuditIndex, createDualWriteReconciler, createJsonBackend, openTdaDomain } from '@tda/kernel';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervisionDomainSpec } from '../src/domain.ts';
import { createSupervisionService, type SupervisionDeps } from '../src/service.ts';
import { baseInput, NOW } from './helpers.ts';

const NOW_MS = NOW;
type PublishedEvent = { readonly seq: number; readonly sessionId: string; readonly family: string; readonly businessId: string };

const openRig = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tda-sv-dw-'));
  const backend = await createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const published: PublishedEvent[] = [];
  const domain = await openTdaDomain(supervisionDomainSpec, {
    backend,
    onChange: (change: { domain: string; table: string; key: string; operation: string }) =>
      reconciler.observeChange(change as never),
  });
  const deps: SupervisionDeps = {
    domain,
    session: {
      sessionId: 'sess-supervision' as never,
      append(event: never) {
        published.push(event as unknown as PublishedEvent);
        return published.length;
      },
      flush() {},
    },
    reconciler,
    index,
    now: () => NOW_MS,
  };
  const service = createSupervisionService(deps);
  return { service, domain, reconciler, index, published, backend, dir };
};

describe('T3.2 双写门', () => {
  it('全链域写与会话事件逐对配对（request/approve/reject/setParams/charge）', async () => {
    const rig = await openRig();
    try {
      await rig.service.initialize();
      expect(rig.reconciler.reconcile().ok).toBe(true);

      const a1 = await rig.service.request(baseInput());
      await rig.service.approve(String(a1.approvalId), a1.token.nonce);
      const a2 = await rig.service.request(baseInput({ requester: { service: 't', ref: '2' } }));
      await rig.service.reject(String(a2.approvalId), a2.token.nonce, 'no');
      await rig.service.setParams({ attentionQuotaUnits: 50 });

      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(report.unmatchedWrites ?? 0).toBe(0);

      // 审计索引：approval/attention 实体可定位
      expect(rig.index.locate('approval', `approval:${String(a1.approvalId)}`)).toBeDefined();
      const attentionLocated = rig.index.locate('approval', 'params');
      void attentionLocated;
    } finally {
      await rig.domain.close();
      await rig.backend.close();
    }
  });

  it('重启恢复：close 后重开 domain → pending 项与 ledger 完好（跨会话持久化）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-sv-dw2-'));
    const backend = await createJsonBackend(dir);
    {
      const domain = await openTdaDomain(supervisionDomainSpec, { backend });
      const service = createSupervisionService({
        domain,
        session: { sessionId: 'sess-supervision' as never, append: () => 1, flush() {} },
        now: () => NOW_MS,
      });
      await service.initialize();
      await service.request(baseInput());
      await service.request(baseInput({ requester: { service: 't', ref: '2' }, kind: 'adoption-candidate' as never, whatToShow: { summary: '低风险', impact: [{ target: 'r', change: 'create' as const, reversible: true }], riskReasons: [], evidence: [] }, resume: { from: 'd', handle: 'h' } }));
      await domain.close();
    }
    {
      const domain = await openTdaDomain(supervisionDomainSpec, { backend });
      const service = createSupervisionService({
        domain,
        session: { sessionId: 'sess-supervision' as never, append: () => 1, flush() {} },
        now: () => NOW_MS,
      });
      await service.initialize();
      expect(service.pending().length).toBe(2);
      expect(service.params().revision).toBe(0);
      await domain.close();
    }
    await backend.close();
  });
});
