/**
 * tda-intake 门 1：不变量（纯函数逐分支 + 加载期检查）。
 *
 * 覆盖 T4.2 §4.1：deriveQuestions 确定性（不变量 2）/validateProposal 校验门
 * （不变量 3）/加载期四查（params 单行/原文隔离/committed 溯源/零编辑面）。
 */
import { describe, expect, it } from 'vitest';
import { createTdaInvariantRegistry } from '@tda/kernel';
import { registerIntakeInvariants } from '../src/loadChecks.ts';
import { deriveQuestionsFromSeed, validateProposal } from '../src/service.ts';
import { setup } from './helpers.ts';
import type { ProposedGoalNode } from '../src/domain.ts';

describe('T4.2 澄清问题确定性（deriveQuestionsFromSeed 纯函数）', () => {
  it('全空种子：两条 blocking（objective/criteria）+ 两条非 blocking', () => {
    const questions = deriveQuestionsFromSeed({ objective: '', completionCriteria: [], constraints: [] });
    expect(questions.map((question) => question.id)).toEqual([
      'q-objective',
      'q-criteria',
      'q-constraints',
      'q-budget',
    ]);
    expect(questions.find((question) => question.id === 'q-objective')?.blocking).toBe(true);
    expect(questions.find((question) => question.id === 'q-criteria')?.blocking).toBe(true);
    expect(questions.find((question) => question.id === 'q-constraints')?.blocking).toBe(false);
    expect(questions.find((question) => question.id === 'q-budget')?.blocking).toBe(false);
  });

  it('完整种子：零问题（ready 直判）', () => {
    const questions = deriveQuestionsFromSeed({
      objective: '目标',
      completionCriteria: ['标准'],
      constraints: ['约束'],
      budgetHint: { tokens: 1000 },
    });
    expect(questions).toEqual([]);
  });

  it('同输入同输出（确定性对账）', () => {
    const seed = { objective: 'x', completionCriteria: ['y'], constraints: [] };
    expect(deriveQuestionsFromSeed(seed)).toEqual(deriveQuestionsFromSeed(seed));
  });
});

describe('T4.2 分解校验门（validateProposal 纯函数）', () => {
  const goodNodes = (overrides: Partial<ProposedGoalNode> = {}): ProposedGoalNode[] => [
    { tempId: 'g1', objective: '根目标', completionCriteria: ['标准'], ...overrides },
    { tempId: 'g1.1', parentTempId: 'g1', objective: '子目标', completionCriteria: ['子标准'] },
  ];

  it('好提议六查全过', () => {
    const report = validateProposal(goodNodes());
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(6);
    expect(report.checks.every((item) => item.passed)).toBe(true);
  });

  it('criteria 空 / tempId 悬空 / 成环 / 多根 / 预算非法 被确定性拒', () => {
    expect(validateProposal([{ tempId: 'g1', objective: 'x', completionCriteria: [] }]).passed).toBe(false);
    expect(validateProposal([{ tempId: 'g1', parentTempId: 'ghost', objective: 'x', completionCriteria: ['c'] }]).passed).toBe(false);
    expect(
      validateProposal([
        { tempId: 'g1', parentTempId: 'g2', objective: 'x', completionCriteria: ['c'] },
        { tempId: 'g2', parentTempId: 'g1', objective: 'y', completionCriteria: ['c'] },
      ]).passed,
    ).toBe(false);
    expect(
      validateProposal([
        { tempId: 'g1', objective: 'x', completionCriteria: ['c'] },
        { tempId: 'g2', objective: 'y', completionCriteria: ['c'] },
      ]).passed,
    ).toBe(false);
    expect(validateProposal([{ tempId: 'g1', objective: 'x', completionCriteria: ['c'], budget: { tokens: 0 } }]).passed).toBe(false);
  });

});

// ── 加载期检查 ─────────────────────────────────────────────────────────

describe('T4.2 加载期检查', () => {
  it('正常域 verify 通过', async () => {
    const rig = await setup();
    try {
      const registry = createTdaInvariantRegistry();
      registerIntakeInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-intake')).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('objective 疑似原文入域 ⇒ verify 红（J2 原文隔离）', async () => {
    const rig = await setup();
    try {
      const { draftId } = await makeDraft(rig);
      const draft = rig.service.draft(draftId);
      expect(draft).toBeDefined();
      // 注毒：objective 塞入超长疑似原文
      await rig.domain.table('intake_drafts').put(draftId, {
        ...draft!,
        objective: '长'.repeat(600),
      } as never);
      const registry = createTdaInvariantRegistry();
      registerIntakeInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-intake')).rejects.toThrowError(/原文入域/);
    } finally {
      await rig.dispose();
    }
  });

  it('服务面携带越权方法（edit）⇒ verify 红（J7 零目标编辑权）', async () => {
    const rig = await setup();
    try {
      const rogue = { ...rig.service, edit: () => undefined };
      const registry = createTdaInvariantRegistry();
      registerIntakeInvariants(registry, rig.domain, { service: rogue as never });
      await expect(registry.verify('tda-intake')).rejects.toThrowError(/越权方法/);
      const ok = createTdaInvariantRegistry();
      registerIntakeInvariants(ok, rig.domain, { service: rig.service });
      await expect(ok.verify('tda-intake')).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });
});

// ── 内部助手 ───────────────────────────────────────────────────────────

async function makeDraft(rig: Awaited<ReturnType<typeof setup>>): Promise<{ draftId: string }> {
  const draft = await rig.service.intake('human', { text: '需要整理灯环协议依赖' });
  return { draftId: draft.id };
}

