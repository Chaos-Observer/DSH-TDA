/**
 * tda-intake 验收门（门3 test:smoke → gate.spec）。
 *
 * 覆盖 T4.2 §6 验收 1–10：原文隔离/抽取可解释/问题确定性与轮次帽/分解校验门/
 * 确认门/代建追溯/拒绝与 supersede/半树显式终态/单活动草稿/零工序兜底。
 */
import { describe, expect, it } from 'vitest';
import { NOW, setup } from './helpers.ts';

/** 全链：intake→extract→propose→confirm→commit（返回各阶段产物）。 */
async function fullPipeline(rig: Awaited<ReturnType<typeof setup>>) {
  const draft = await rig.service.intake('human', { text: '需要整理灯环协议依赖清单，产出可核对的依赖图谱' });
  const extracted = await rig.service.extract(draft.id);
  const proposal = await rig.service.propose(extracted.id);
  const { approvalId } = await rig.service.confirmRequest('human', proposal.id);
  return { draft, extracted, proposal, approvalId };
}

describe('T4.2 验收 1–2：原文隔离与抽取可解释', () => {
  it('原文只落 timeline chunk，域内只存 rawEntryId 引用', async () => {
    const rig = await setup();
    try {
      const rawText = '需要整理灯环协议依赖清单，这段长文本全文应该只出现在时间线'.repeat(10);
      const draft = await rig.service.intake('human', { text: rawText });
      // 原文全文在 timeline（唯一载体）
      expect(rig.timeline.chunks).toHaveLength(1);
      expect(rig.timeline.chunks[0]?.content).toBe(rawText);
      expect(rig.timeline.chunks[0]?.entryId).toBe(draft.rawEntryId);
      // 域内无全文（objective 空待抽取；各字段均非原文）
      const stored = rig.service.draft(draft.id);
      expect(stored?.objective).toBe('');
      expect(JSON.stringify(stored)).not.toContain(rawText.slice(0, 20));
    } finally {
      await rig.dispose();
    }
  });

  it('抽取带 ExtractionMeta；scripted provider 同输入确定性', async () => {
    const rig = await setup();
    try {
      const draft = await rig.service.intake('human', { text: 'x' });
      const extracted = await rig.service.extract(draft.id);
      expect(extracted.extraction.provider).toBe('scripted');
      expect(extracted.extraction.model).toBe('fake-sidekick');
      expect(extracted.extraction.schemaHash).toBe('sha-draft');
      expect(extracted.objective).toBe('整理灯环协议依赖清单');
      // 同输入再抽取（同 rig 同草稿禁重复抽取——确定性由纯函数 deriveQuestions 保证）
      await expect(rig.service.extract(draft.id)).rejects.toThrowError(/非 drafting/);
    } finally {
      await rig.dispose();
    }
  });

  it('无 extractor 时 extract 抛 NO_EXTRACTOR（禁假造草稿）', async () => {
    const rig = await setup({ withoutExtractor: true });
    try {
      const draft = await rig.service.intake('human', { text: 'x' });
      await expect(rig.service.extract(draft.id)).rejects.toThrowError(/未注入 LLM 抽取工序/);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.2 验收 3：问题确定性与轮次帽（J8）', () => {
  it('稀疏抽取 ⇒ blocking 问题；回答回写消减；全答 ⇒ ready', async () => {
    const rig = await setup();
    try {
      const draft = await rig.service.intake('human', { text: 'x' });
      rig.extractor.mode = 'sparse';
      const sparse = await rig.service.extract(draft.id);
      expect(sparse.status).toBe('drafting');
      const blocking = sparse.openQuestions.filter((question) => question.blocking && question.answer === undefined);
      expect(blocking.map((question) => question.id)).toEqual(['q-objective', 'q-criteria']);

      // 回答两条 blocking ⇒ ready
      const answered = await rig.service.answer('human', draft.id, [
        { questionId: 'q-objective', answer: '整理灯环依赖' },
        { questionId: 'q-criteria', answer: '清单产出' },
      ]);
      expect(answered.status).toBe('ready');
      expect(answered.clarificationRounds).toBe(1);
    } finally {
      await rig.dispose();
    }
  });

  it('deriveQuestions 纯函数面：同草稿同输出', async () => {
    const rig = await setup();
    try {
      const draft = await rig.service.intake('human', { text: 'x' });
      await rig.service.extract(draft.id);
      const first = rig.service.deriveQuestions(draft.id);
      const second = rig.service.deriveQuestions(draft.id);
      expect(first).toEqual(second);
    } finally {
      await rig.dispose();
    }
  });

  it('轮次帽：达帽后仍 blocking ⇒ escalation 提请；再答 ⇒ CAP_REACHED 拒', async () => {
    const rig = await setup({ config: { maxClarificationRounds: 1 } });
    try {
      const draft = await rig.service.intake('human', { text: 'x' });
      rig.extractor.mode = 'sparse';
      await rig.service.extract(draft.id); // blocking 存留
      // 第 1 轮（=帽）：只答非 blocking（constraints），blocking 仍存 ⇒ escalation
      await rig.service.answer('human', draft.id, [{ questionId: 'q-constraints', answer: '无' }]);
      const escalation = rig.supervision.requests.find((request) => request.kind === 'requirement-clarify');
      expect(escalation).toBeDefined();
      expect(escalation?.summary).toContain('blocking');
      // 超帽后再答 ⇒ 拒（禁静默继续）
      await expect(
        rig.service.answer('human', draft.id, [{ questionId: 'q-objective', answer: 'y' }]),
      ).rejects.toThrowError(/轮次已达帽/);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.2 验收 4–6：校验门、确认门、代建追溯', () => {
  it('四类坏提议被确定性拒（提议留档，禁提请）', async () => {
    for (const mode of ['dangling', 'multi-root', 'cycle', 'empty-criteria'] as const) {
      const rig = await setup();
      try {
        const draft = await rig.service.intake('human', { text: 'x' });
        await rig.service.extract(draft.id);
        rig.decomposer.mode = mode;
        await expect(rig.service.propose(draft.id)).rejects.toThrowError(/校验未过/);
        // 提议留档但状态停在 draft；confirmRequest 拒
        const failed = rig.service.proposals().at(-1);
        expect(failed?.status).toBe('draft');
        expect(failed?.validation.passed).toBe(false);
        await expect(rig.service.confirmRequest('human', failed?.id ?? '')).rejects.toThrowError(/校验未过/);
      } finally {
        await rig.dispose();
      }
    }
  });

  it('确认门：whatToShow 摘要 + 定级理由；token 一次性（重放被拒）', async () => {
    const rig = await setup();
    try {
      const { proposal, approvalId } = await fullPipeline(rig);
      const request = rig.supervision.requests.find((item) => item.kind === 'requirement-confirm');
      expect(request?.summary).toContain(`目标树 ${proposal.nodes.length} 节点`);
      expect(request?.summary).toContain('完成标准');
      // 首次凭票代建成功；同票据重放 ⇒ 拒（一次性）
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      expect(ticket.from).toBe('ctx.intake');
      await rig.service.commit(proposal.id, ticket);
      await expect(rig.service.commit(proposal.id, ticket)).rejects.toThrowError(/已消费|非 pending-approval/);
    } finally {
      await rig.dispose();
    }
  });

  it('代建拓扑序 + 每个节点 source=intake ∧ intakeProposalId（T0.1 v2 溯源）', async () => {
    const rig = await setup();
    try {
      const { proposal, approvalId } = await fullPipeline(rig);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      const created = await rig.service.commit(proposal.id, ticket);
      expect(created).toHaveLength(2);
      // 拓扑序：父先子后
      expect(rig.goalTree.calls).toEqual(['create:整理灯环协议依赖清单', 'create:子目标：收集依赖']);
      // 溯源字段
      for (const goalId of created) {
        const view = rig.goalTree.goals.get(goalId);
        expect(view?.source).toBe('intake');
        expect(view?.intakeProposalId).toBe(proposal.id);
      }
      // createdGoalIds 回填 + draft → committed
      const committed = rig.service.proposal(proposal.id);
      expect(committed?.status).toBe('committed');
      expect(committed?.createdGoalIds).toEqual(created);
      expect(rig.service.drafts()[0]?.status).toBe('committed');
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.2 验收 7–10：拒绝/supersede/半树/单活动草稿', () => {
  it('reject 后禁建；draft 落 rejected', async () => {
    const rig = await setup();
    try {
      const { proposal, approvalId } = await fullPipeline(rig);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await rig.service.reject(proposal.id, ticket);
      expect(rig.service.proposal(proposal.id)?.status).toBe('rejected');
      expect(rig.service.drafts()[0]?.status).toBe('rejected');
      await expect(rig.service.commit(proposal.id, ticket)).rejects.toThrowError(/已消费|非 pending-approval/);
      expect(rig.goalTree.calls).toEqual([]); // 零代建
    } finally {
      await rig.dispose();
    }
  });

  it('committed 草稿被新需求 supersede（链指针；已建目标不动）', async () => {
    const rig = await setup();
    try {
      const { approvalId } = await fullPipeline(rig);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      const firstPipeline = rig.service.proposals()[0];
      await rig.service.commit(firstPipeline?.id ?? '', ticket);
      const goalsBefore = [...rig.goalTree.goals.keys()];

      // 新需求进来：旧 committed 草稿自动 superseded + 新草稿携 supersedes 指针
      const next = await rig.service.intake('human', { text: '新需求：灯环配对流程' });
      const old = rig.service.drafts().find((draft) => draft.supersedes === undefined || draft.status === 'superseded');
      expect(old?.status).toBe('superseded');
      expect(next.supersedes).toBe(old?.id);
      // 已建目标不动
      expect([...rig.goalTree.goals.keys()]).toEqual(goalsBefore);
    } finally {
      await rig.dispose();
    }
  });

  it('半树显式终态：中途失败已建节点保留 + proposal cancelled（禁静默回滚）', async () => {
    const rig = await setup();
    try {
      const { proposal, approvalId } = await fullPipeline(rig);
      // 注入失败：第二个节点（子目标）创建抛错
      rig.goalTree.configureFailOn('子目标');
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await expect(rig.service.commit(proposal.id, ticket)).rejects.toThrowError(/GOAL_CREATE_FAILED/);
      // 已建节点保留（父目标在；第二个 create 已调用但抛错未落账），proposal 落 cancelled + 部分回填
      expect(rig.goalTree.calls).toEqual(['create:整理灯环协议依赖清单', 'create:子目标：收集依赖']);
      expect(rig.goalTree.goals.size).toBe(1);
      expect(rig.service.proposal(proposal.id)?.status).toBe('cancelled');
      expect(rig.service.proposal(proposal.id)?.createdGoalIds).toHaveLength(1);
    } finally {
      await rig.dispose();
    }
  });

  it('单活动草稿：第二个 intake 遇活动草稿 fail-loud', async () => {
    const rig = await setup();
    try {
      await rig.service.intake('human', { text: '第一条需求' });
      await expect(rig.service.intake('human', { text: '第二条需求' })).rejects.toThrowError(/单活动草稿/);
    } finally {
      await rig.dispose();
    }
  });

  it('无 decomposer 时 propose 抛 NO_DECOMPOSER', async () => {
    const rig = await setup({ withoutDecomposer: true });
    try {
      const draft = await rig.service.intake('human', { text: 'x' });
      await rig.service.extract(draft.id);
      await expect(rig.service.propose(draft.id)).rejects.toThrowError(/未注入 Lead 分解工序/);
      void NOW;
    } finally {
      await rig.dispose();
    }
  });
});
