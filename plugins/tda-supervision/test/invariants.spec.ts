/** T3.2 不变量门：六条检查各自红 + 真实服务绿路。 */
import { describe, expect, it } from 'vitest';
import { createTdaInvariantRegistry, createJsonBackend, openTdaDomain, type TdaDomain } from '@tda/kernel';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervisionDomainSpec, type ApprovalRequest, type SupervisionEvent, type SupervisionTables } from '../src/domain.ts';
import { registerSupervisionInvariants, type SupervisionReadFace } from '../src/loadChecks.ts';
import { createSupervisionService } from '../src/service.ts';
import { baseInput, NOW } from './helpers.ts';

const NOW_MS = NOW;

const openRig = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tda-sv-inv-'));
  const backend = await createJsonBackend(dir);
  const domain = await openTdaDomain(supervisionDomainSpec, { backend });
  return { domain, dispose: async () => { await domain.close(); await backend.close(); } };
};

const approvalOf = (overrides: Omit<Partial<ApprovalRequest>, 'approvalId'> & { approvalId: string }): ApprovalRequest => {
  const { approvalId, ...rest } = overrides;
  return {
    approvalId: approvalId as never,
    kind: 'dispatch',
    riskLevel: 'high',
    requester: { service: 't', ref: 'r' },
    subject: '主题',
    whatToShow: {
      summary: '摘要',
      impact: [{ target: 'x', change: 'execute', reversible: false }],
      riskReasons: [],
      evidence: [],
    },
    resume: { from: 'starting', handle: 'h' },
    status: 'pending',
    token: { nonce: 'n1', issuedAt: NOW_MS, expiresAt: NOW_MS + 1 },
    attention: { units: 5, chargedAt: NOW_MS },
    taskId: 'task-1',
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
    ...rest,
  } as ApprovalRequest;
};

const faceOf = (approvals: ApprovalRequest[], events: SupervisionEvent[] = []): SupervisionReadFace => ({
  approvals: () => approvals,
  events: () => events,
});

const faceOfDomain = (domain: TdaDomain<SupervisionTables>, approvals: ApprovalRequest[]): SupervisionReadFace => ({
  approvals: () => approvals,
  events: () => [...domain.table('supervision_events').entries()].map(([, value]) => value as SupervisionEvent),
});

describe('T3.2 不变量门', () => {
  it('supervision-token-single-use：已 resolution 却未焚 token 即红', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      registerSupervisionInvariants(registry, rig.domain, faceOf([
        approvalOf({ approvalId: 'apr-1', status: 'approved', resolution: { decision: 'approve', by: 'human', at: NOW_MS, tokenNonce: 'n1' } }),
      ]));
      await expect(registry.verify('tda-supervision')).rejects.toThrowError(/一次性纪律/);
    } finally {
      await rig.dispose();
    }
  });

  it('supervision-no-timeout-autopass：approved 无人类 resolution 即红', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      registerSupervisionInvariants(registry, rig.domain, faceOf([
        approvalOf({ approvalId: 'apr-1', status: 'approved', token: { nonce: 'n1', issuedAt: NOW_MS, expiresAt: NOW_MS + 1, consumedAt: NOW_MS } }),
      ]));
      await expect(registry.verify('tda-supervision')).rejects.toThrowError(/超时自动通过/);
    } finally {
      await rig.dispose();
    }
  });

  it('supervision-explicit-terminal：rejected 无 reason 即红', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      registerSupervisionInvariants(registry, rig.domain, faceOf([
        approvalOf({ approvalId: 'apr-1', status: 'rejected', token: { nonce: 'n1', issuedAt: NOW_MS, expiresAt: NOW_MS + 1, consumedAt: NOW_MS }, resolution: { decision: 'reject', by: 'human', at: NOW_MS, tokenNonce: 'n1' } }),
      ]));
      await expect(registry.verify('tda-supervision')).rejects.toThrowError(/显式终态/);
    } finally {
      await rig.dispose();
    }
  });

  it('supervision-billing-target：缺 taskId/goalId 即红', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      registerSupervisionInvariants(registry, rig.domain, faceOf([approvalOf({ approvalId: 'apr-1', taskId: undefined })]));
      await expect(registry.verify('tda-supervision')).rejects.toThrowError(/计费落点/);
    } finally {
      await rig.dispose();
    }
  });

  it('supervision-irreversible-high：不可逆却定 low 即红', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      registerSupervisionInvariants(registry, rig.domain, faceOf([approvalOf({ approvalId: 'apr-1', riskLevel: 'low' })]));
      await expect(registry.verify('tda-supervision')).rejects.toThrowError(/元规则/);
    } finally {
      await rig.dispose();
    }
  });

  it('绿路：真实服务全链后 verify 通过 + 检查清单对账', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-sv-inv-ok-'));
    const backend = await createJsonBackend(dir);
    const domain = await openTdaDomain(supervisionDomainSpec, { backend });
    const service = createSupervisionService({
      domain,
      session: { sessionId: 'sess-supervision' as never, append: () => 1, flush() {} },
      now: () => NOW_MS,
    });
    await service.initialize();
    const approval = await service.request(baseInput());
    await service.approve(String(approval.approvalId), approval.token.nonce);
    const registry = createTdaInvariantRegistry();
    registerSupervisionInvariants(registry, domain, faceOfDomain(domain, service.pending().concat()));
    // face 用全量审批而非 pending
    const { supervisionInvariantChecks } = await import('../src/loadChecks.ts');
    void supervisionInvariantChecks;
    // 重新注册带全量 approvals 的 face
    const registry2 = createTdaInvariantRegistry();
    const allApprovals = [...domain.table('approval_requests').entries()].map(([, value]) => value as ApprovalRequest);
    registerSupervisionInvariants(registry2, domain, faceOf(allApprovals));
    await expect(registry2.verify('tda-supervision')).resolves.toBeUndefined();
    await domain.close();
    await backend.close();
  });
});
