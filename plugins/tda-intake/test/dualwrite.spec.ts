/**
 * tda-intake 双写对账门（门3 test:dualwrite）。
 *
 * 写组合：draft 与 proposal **均为权威**（`dualWrite` + 族 `intake/change`，
 * businessId=draftId/proposalId/'params'）——需求草稿与目标树提议是审计事实
 * （J9：LLM 工序元数据随记录落盘，回放可解释）。本门验证配对、索引、
 * 总线载荷与回放等价。
 */
import { describe, expect, it } from 'vitest';
import { assertReplayEquivalence, compareReplay } from '@tda/testkit';
import { setup } from './helpers.ts';

/** 走完 intake→extract→propose→confirm→commit 全链。 */
async function runFullPipeline(rig: Awaited<ReturnType<typeof setup>>): Promise<{ proposalId: string }> {
  const draft = await rig.service.intake('human', { text: '需要整理灯环协议依赖清单' });
  await rig.service.extract(draft.id);
  const proposal = await rig.service.propose(draft.id);
  const { approvalId } = await rig.service.confirmRequest('human', proposal.id);
  const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
  await rig.service.commit(proposal.id, ticket);
  return { proposalId: proposal.id };
}

describe('T4.2 双写与审计', () => {
  it('params 种子与 draft/proposal 生命周期逐一配对；无反向洞', async () => {
    const rig = await setup();
    try {
      await runFullPipeline(rig);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(report.unpairedChanges).toHaveLength(0);
      expect(report.unmatchedWrites).toBe(0);
      // params 种子 1 + draft 建档/抽取回写/committed 3 + proposal 建档/提请/committed 3
      expect(report.pairedWrites).toBeGreaterThanOrEqual(7);
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 按 requirement/proposal 实体延展；locate 可定位', async () => {
    const rig = await setup();
    try {
      const { proposalId } = await runFullPipeline(rig);
      // 内核 FAMILY_MAP 每 family 单一 entityKind：intake/change 全部索引为
      // 'requirement'（proposal 记录同族同种类——trajectory 的 ENTITY_FAMILY
      // 双映射供回放对账，index 种类以内核为准）。
      const locatedProposal = rig.index.locate('requirement', proposalId);
      expect(locatedProposal?.entityId).toBe(proposalId);
      const drafts = rig.service.drafts();
      expect(drafts).toHaveLength(1);
      const locatedDraft = rig.index.locate('requirement', drafts[0]?.id ?? '');
      expect(locatedDraft?.entityId).toBe(drafts[0]?.id);
    } finally {
      await rig.dispose();
    }
  });

  it('总线载荷 = 全快照（键序与 schema 定义序一致）', async () => {
    const rig = await setup();
    try {
      const { proposalId } = await runFullPipeline(rig);
      const last = rig.published.filter((event) => event.businessId === proposalId).at(-1);
      expect(last).toBeDefined();
      expect(Object.keys(last?.payload ?? {})).toEqual([
        'id',
        'revision',
        'draftId',
        'status',
        'nodes',
        'validation',
        'decomposition',
        'approval',
        'createdGoalIds',
        'createdAt',
        'settledAt',
      ]);
    } finally {
      await rig.dispose();
    }
  });

  it('回放等价：按日志重建 draft/proposal/params 与域内逐字节一致', async () => {
    const rig = await setup();
    try {
      await runFullPipeline(rig);
      await rig.service.setParams('human', { maxClarificationRounds: 5 });
      const events = rig.published;
      // 双表分账：draft 载荷有 rawEntryId、proposal 载荷有 draftId（键形状判别）
      const isProposalEvent = (event: { payload: Record<string, unknown> }): boolean =>
        'draftId' in event.payload;
      const draftsDiff = compareReplay(
        events,
        rig.domain.table('intake_drafts').entries(),
        (event) =>
          event.businessId === 'params' || isProposalEvent(event)
            ? undefined
            : { key: event.businessId, value: event.payload },
      );
      assertReplayEquivalence(draftsDiff);
      const proposalsDiff = compareReplay(
        events,
        rig.domain.table('intake_proposals').entries(),
        (event) =>
          event.businessId === 'params' || !isProposalEvent(event)
            ? undefined
            : { key: event.businessId, value: event.payload },
      );
      assertReplayEquivalence(proposalsDiff);
      const paramsDiff = compareReplay(
        events,
        rig.domain.table('intake_params').entries(),
        (event) => (event.businessId === 'params' ? { key: 'singleton', value: event.payload } : undefined),
      );
      assertReplayEquivalence(paramsDiff);
      expect(draftsDiff.equal).toBe(true);
      expect(proposalsDiff.equal).toBe(true);
      expect(paramsDiff.equal).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});
