/**
 * T2.2 冒烟门（验收 §6.1–§6.8）。
 */
import { describe, expect, it } from 'vitest';
import { draftOf, setup } from './helpers.ts';

const ACTOR = { actor: 'human' as const, sessionId: 'sess-skill' };

describe('T2.2 技能生命周期冒烟门', () => {
  it('1. G2-① 主项：回放+真实复用才晋升（零复用固化拒绝）', async () => {
    const fx = await setup({ withMaterializer: true });
    try {
      const skill = await fx.service.propose(ACTOR, draftOf('pair-light-ring'));
      expect(fx.governance.lifecycles.get(String(skill.id))).toBeUndefined(); // draft

      // 未过 rehearsal 不得进 validating（不变量 1）+ 零复用固化拒绝（不变量 2）
      await expect(fx.service.requestConsolidate(ACTOR, String(skill.id))).rejects.toMatchObject({
        code: 'SKILL_NO_REHEARSAL_PASS',
      });

      const run = await fx.service.rehearse(ACTOR, String(skill.id), 'task-1');
      expect(run.verdict).toBe('pass');
      expect(fx.governance.lifecycles.get(String(skill.id))).toBe('validating');
      // validating = 能力召回通道可见（带标注），DSH 物化尚未发生
      const injected = fx.service.injectCandidates();
      expect(injected.some((item) => String(item.skill.id) === String(skill.id) && item.validating)).toBe(true);
      expect(fx.materialized.written).toEqual([]);

      // 零真实复用时 consolidate 被拒（G2-① 自检）
      await expect(fx.service.requestConsolidate(ACTOR, String(skill.id))).rejects.toMatchObject({
        code: 'SKILL_NO_REAL_USE',
      });

      await fx.service.logUse(ACTOR, String(skill.id), 'task-2', 'success');
      await fx.service.requestConsolidate(ACTOR, String(skill.id));
      expect(fx.governance.lifecycles.get(String(skill.id))).toBe('consolidated');
      expect(fx.materialized.written).toEqual(['pair-light-ring.md']);
    } finally {
      await fx.dispose();
    }
  });

  it('2. Voyager 铁律：composite 前置未 consolidated → rehearse/consolidate 拒绝', async () => {
    const fx = await setup();
    try {
      const base = await fx.service.propose(ACTOR, draftOf('base-skill'));
      const composite = await fx.service.propose(
        ACTOR,
        draftOf('composite-skill', {
          kind: 'composite',
          procedure: { steps: [{ action: 'dispatch:sub' }], prerequisites: [String(base.id)] },
        }),
      );
      await expect(fx.service.rehearse(ACTOR, String(composite.id), 'task-1')).rejects.toMatchObject({
        code: 'SKILL_PREREQ_NOT_CONSOLIDATED',
      });
      // 前置固化后通过
      await fx.service.rehearse(ACTOR, String(base.id), 'task-1');
      await fx.service.logUse(ACTOR, String(base.id), 'task-1', 'success');
      await fx.service.requestConsolidate(ACTOR, String(base.id));
      const run = await fx.service.rehearse(ACTOR, String(composite.id), 'task-1');
      expect(run.verdict).toBe('pass');
    } finally {
      await fx.dispose();
    }
  });

  it('3. 退役承重（Ratchet）：rehearsal-fail 自动退役 + use-fail 滞回 + 退役后双通道不可见', async () => {
    const fx = await setup();
    try {
      const skill = await fx.service.propose(ACTOR, draftOf('flaky-skill'));
      // 连续 3 次 fail → retire[rehearsal-fail]
      fx.executor.script.push(
        { outcome: 'failure', coverage: 0.1 },
        { outcome: 'failure', coverage: 0.2 },
        { outcome: 'failure', coverage: 0.3 },
      );
      await fx.service.rehearse(ACTOR, String(skill.id), 'task-1');
      await fx.service.rehearse(ACTOR, String(skill.id), 'task-1');
      await fx.service.rehearse(ACTOR, String(skill.id), 'task-1');
      const retireAction = fx.governance.actions.at(-1)!;
      expect(retireAction.action).toBe('retire');
      expect(retireAction.reason!.kind).toBe('rehearsal-fail');
      // 退役后召回注入池不可见
      expect(fx.service.injectCandidates().some((item) => String(item.skill.id) === String(skill.id))).toBe(false);
    } finally {
      await fx.dispose();
    }

    const fx2 = await setup();
    try {
      // use-fail 滞回：2 fail + 1 success（清零）+ 3 fail → retire
      const skill = await fx2.service.propose(ACTOR, draftOf('use-fail-skill'));
      await fx2.service.rehearse(ACTOR, String(skill.id), 'task-1');
      await fx2.service.logUse(ACTOR, String(skill.id), 't1', 'failure');
      await fx2.service.logUse(ACTOR, String(skill.id), 't2', 'failure');
      await fx2.service.logUse(ACTOR, String(skill.id), 't3', 'success');
      expect(fx2.governance.actions.some((action) => action.action === 'retire')).toBe(false);
      await fx2.service.logUse(ACTOR, String(skill.id), 't4', 'failure');
      await fx2.service.logUse(ACTOR, String(skill.id), 't5', 'failure');
      await fx2.service.logUse(ACTOR, String(skill.id), 't6', 'failure');
      expect(
        fx2.governance.actions.some((action) => action.action === 'retire' && action.reason!.kind === 'use-fail'),
      ).toBe(true);
    } finally {
      await fx2.dispose();
    }
  });

  it('4. 写时冲突检测：同名拒绝 / near-dup / contradiction 只标不裁 / supersede 收敛', async () => {
    const fx = await setup();
    try {
      await fx.service.propose(ACTOR, draftOf('first-skill'));
      // 同名拒绝
      await expect(fx.service.propose(ACTOR, draftOf('first-skill'))).rejects.toMatchObject({
        code: 'SKILL_NAME_TAKEN',
      });
      // near-dup：applicability 重叠 + 步骤相似
      const nearDup = await fx.service.propose(ACTOR, draftOf('second-skill'));
      expect(nearDup.conflict).toMatchObject({ kind: 'near-dup' });
      // contradiction：重叠 + 零共同动作
      const contradiction = await fx.service.propose(
        ACTOR,
        draftOf('third-skill', {
          procedure: { steps: [{ action: 'query:db' }, { action: 'dispatch:sub' }], prerequisites: [] },
        }),
      );
      expect(contradiction.conflict).toMatchObject({ kind: 'contradiction' });
      // 两技能定义均未被改动（只标不裁）
      const first = (await fx.service.skills()).find((skill) => skill.name === 'first-skill')!;
      expect(first.conflict).toBeUndefined();
      // supersede 收敛：新版 + 旧版 retire[superseded]
      const v2 = await fx.service.supersede(ACTOR, String(first.id), draftOf('first-skill-v2'));
      expect(v2.supersedes).toBe(String(first.id));
      expect(fx.governance.actions.some((action) => action.assetId === String(first.id) && action.action === 'retire')).toBe(true);
      const chain = fx.service.history(String(v2.id));
      expect(chain.map((skill) => skill.name)).toEqual(['first-skill-v2', 'first-skill']);
    } finally {
      await fx.dispose();
    }
  });

  it('5. Elo 可解释：success/failure/partial 序列逐条复算（不变量 7）', async () => {
    const fx = await setup();
    try {
      const skill = await fx.service.propose(ACTOR, draftOf('elo-skill'));
      await fx.service.rehearse(ACTOR, String(skill.id), 'task-0');
      const K = 24;
      let rating = 1500;
      for (const outcome of ['success', 'failure', 'partial'] as const) {
        const use = await fx.service.logUse(ACTOR, String(skill.id), 'task-1', outcome);
        const s = outcome === 'success' ? 1 : outcome === 'partial' ? 0.5 : 0;
        const expected = rating + K * (s - 1 / (1 + 10 ** ((1500 - rating) / 400)));
        expect(use.eloBefore).toBe(rating);
        expect(use.eloAfter).toBeCloseTo(expected, 6);
        expect(use.k).toBe(K);
        rating = use.eloAfter;
      }
    } finally {
      await fx.dispose();
    }
  });

  it('6. 零原文泄漏：长正文步骤被 schema 拒绝（白名单有牙）', async () => {
    const fx = await setup();
    try {
      await expect(
        fx.service.propose(ACTOR, draftOf('leaky-skill', {
          procedure: { steps: [{ action: 'x'.repeat(120) }], prerequisites: [] },
        })),
      ).rejects.toThrowError(/步骤 action 超 80/);
    } finally {
      await fx.dispose();
    }
  });

  it('7. adoptExternal：人类采纳即阀 → validating，免 rehearsal 直固', async () => {
    const fx = await setup({ withMaterializer: true });
    try {
      const skill = await fx.service.adoptExternal(ACTOR, {
        name: 'dsh-installed-skill',
        dshSkillRef: 'dsh://skills/code-review',
      });
      expect(fx.governance.lifecycles.get(String(skill.id))).toBe('validating');
      expect(skill.credential).toBe('user-original');
      await fx.service.requestConsolidate(ACTOR, String(skill.id));
      expect(fx.governance.lifecycles.get(String(skill.id))).toBe('consolidated');
    } finally {
      await fx.dispose();
    }
  });

  it('8. injectCandidates：Top-K 截断 + validating 标注', async () => {
    const fx = await setup();
    try {
      await fx.service.setParams({ topKInject: 2 });
      for (const name of ['skill-a', 'skill-b', 'skill-c']) {
        const skill = await fx.service.propose(ACTOR, draftOf(name));
        await fx.service.rehearse(ACTOR, String(skill.id), 'task-1');
      }
      const injected = fx.service.injectCandidates();
      expect(injected.length).toBe(2);
      expect(injected.every((item) => item.validating)).toBe(true);
    } finally {
      await fx.dispose();
    }
  });

  it('9. extractFromTrajectory：机械抽取骨架（同 T1.4 两段式）', async () => {
    const fx = await setup();
    try {
      const draft = fx.service.extractFromTrajectory(
        [{ sessionId: 'sess-1', seqFrom: 1, seqTo: 9 }],
        ['read:read', 'edit:write', 'edit:write', 'stage:planning->executing'],
      );
      expect(draft.procedure.steps.map((step) => step.action)).toEqual([
        'read:read',
        'edit:write',
        'stage:planning->executing',
      ]);
      expect(draft.source.kind).toBe('trajectory-extract');
    } finally {
      await fx.dispose();
    }
  });

  it('10. rehearsal 覆盖率阈值：低 coverage fail 且不晋升（θ_cov 判定可复算）', async () => {
    const fx = await setup();
    try {
      const skill = await fx.service.propose(ACTOR, draftOf('low-cov-skill'));
      fx.executor.script.push({ outcome: 'success', coverage: 0.3 });
      const run = await fx.service.rehearse(ACTOR, String(skill.id), 'task-1');
      expect(run.verdict).toBe('fail');
      expect(run.coverage).toBe(0.3);
      expect(fx.governance.lifecycles.get(String(skill.id))).toBeUndefined(); // 仍 draft
    } finally {
      await fx.dispose();
    }
  });
});
