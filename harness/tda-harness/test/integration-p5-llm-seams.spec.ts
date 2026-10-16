/**
 * P5.5 集成门：T4.5/T4.2 的 LLM 工序走 StreamChunk 真通道（llmSeams 适配）。
 *
 * 与既有 planner/intake 集成门的差别：decomposer/extractor/decomposer 不再是
 * 手写脚本闭包，而是 **createLlmXxx({ face })**——face 走 P5.3 的 scripted
 * stream face（chunk 流经 DSH 真 BlockAssembler 组装），LLM 产 JSON 经权威
 * zod schema 门后喂真质量门（coverage/validateProposal）。负例三类显式失败
 * （BAD_JSON / INVALID_OUTPUT / FAILED）——禁假造分解 J2 的通道化落点。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleRuntime, type TdaRuntime } from '../src/runtime.ts';
import {
  createLlmIntakeExtractor,
  createLlmIntakeTreeDecomposer,
  createLlmPlannerDecomposer,
} from '../src/llmSeams.ts';
import { createScriptedStreamFace } from 'tda-subagent-dispatch';
import type { Decomposer } from 'tda-planner';
import type { DraftExtractor, TreeDecomposer } from 'tda-intake';

function createClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface Rig {
  readonly runtime: TdaRuntime;
  dispose(): Promise<void>;
}

async function setup(options: {
  decomposer?: Decomposer;
  intakeExtractor?: DraftExtractor;
  intakeDecomposer?: TreeDecomposer;
}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-harness-p55-seams-'));
  const clock = createClock();
  const runtime = await assembleRuntime({
    dir,
    now: clock.now,
    plannerEnabled: true,
    ...(options.decomposer !== undefined ? { decomposer: options.decomposer } : {}),
    ...(options.intakeExtractor !== undefined ? { intakeExtractor: options.intakeExtractor } : {}),
    ...(options.intakeDecomposer !== undefined ? { intakeDecomposer: options.intakeDecomposer } : {}),
  });
  return {
    runtime,
    async dispose() {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，detached 子进程清理（不占 libuv 线程池）
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    },
  };
}

const PLAN_JSON = {
  tasks: [
    {
      tempId: 't1',
      subject: '主路径：直连抓取',
      completionCriteria: ['证据：抓取完成'],
      blockedByTempIds: [],
      alternativeOfTempId: 't2',
      contingency: { trigger: { kind: 'task-failed', taskTempId: 't1' }, carveOut: 0.5 },
      criteriaRefs: [0],
      localPath: 'ws/a',
      writeScopes: ['ws/b/x'],
    },
    {
      tempId: 't2',
      subject: '备选：迂回抓取',
      completionCriteria: ['证据：迂回完成'],
      blockedByTempIds: [],
      criteriaRefs: [1],
    },
  ],
};

const EXTRACT_JSON = {
  objective: '整理灯环协议依赖清单',
  completionCriteria: ['依赖清单产出并双写对账'],
  constraints: ['不改动固件'],
};

const TREE_JSON = {
  nodes: [
    { tempId: 'g1', objective: '整理灯环协议依赖清单', completionCriteria: ['依赖清单产出'] },
    {
      tempId: 'g1.1',
      parentTempId: 'g1',
      objective: '子目标：收集依赖',
      completionCriteria: ['子标准：清单可核对'],
      pinned: ['不改动固件'],
    },
  ],
};

describe('P5.5 LLM 工序真通道（StreamFace → 权威 schema → 质量门）', () => {
  it('规划分解：LLM 产 JSON → PlannedTask schema 门 → proposePlan 质量门全过', async () => {
    const rig = await setup({
      decomposer: createLlmPlannerDecomposer({
        face: createScriptedStreamFace({ structured: PLAN_JSON, usage: { inputTokens: 30, outputTokens: 120 } }),
      }),
    });
    try {
      const goal = await rig.runtime.goalTree.service.create('human', {
        objective: '完成灯环抓取',
        completionCriteria: ['标准甲：抓取路径验证', '标准乙：备选路径验证'],
      });
      const plan = await rig.runtime.planner.service.proposePlan(String(goal.id));
      expect(plan.coverage.passed).toBe(true);
      expect(plan.tasks).toHaveLength(2);
      expect(plan.generation.provider).toBe('dsh-stream');
      expect(plan.generation.schemaHash).toMatch(/^fnv1a-/);
      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('需求抽取 + 树分解：LLM 产 JSON → 权威 schema 门 → 流水线 ready + 提议校验过', async () => {
    const rawText = '需要整理灯环协议依赖清单（这段原文只应出现在 user-original chunk）';
    const rig = await setup({
      intakeExtractor: createLlmIntakeExtractor({
        face: createScriptedStreamFace({ structured: EXTRACT_JSON }),
        resolveRawText: async () => rawText,
      }),
      intakeDecomposer: createLlmIntakeTreeDecomposer({
        face: createScriptedStreamFace({ structured: TREE_JSON }),
      }),
    });
    try {
      const draft = await rig.runtime.intake.service.intake('human', { text: rawText });
      const extracted = await rig.runtime.intake.service.extract(draft.id);
      expect(extracted.status).toBe('ready');
      expect(extracted.objective).toBe('整理灯环协议依赖清单');
      const proposal = await rig.runtime.intake.service.propose(extracted.id);
      expect(proposal.validation.passed).toBe(true);
      expect(proposal.nodes.map((node) => node.tempId)).toEqual(['g1', 'g1.1']);
      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('负例三类显式失败：BAD_JSON / INVALID_OUTPUT / FAILED（禁假造分解）', async () => {
    const badJson = createLlmPlannerDecomposer({
      face: createScriptedStreamFace({ text: '模型跑题了，没有 JSON。' }),
    });
    await expect(
      badJson({ goalId: 'g', objective: 'x', completionCriteria: ['c'], existingTaskSubjects: [] }),
    ).rejects.toMatchObject({ code: 'LLM_SEAM_BAD_JSON' });

    const invalid = createLlmPlannerDecomposer({
      face: createScriptedStreamFace({ structured: { tasks: [{ tempId: 't1' }] } }),
    });
    await expect(
      invalid({ goalId: 'g', objective: 'x', completionCriteria: ['c'], existingTaskSubjects: [] }),
    ).rejects.toMatchObject({ code: 'LLM_SEAM_INVALID_OUTPUT' });

    const failed = createLlmPlannerDecomposer({
      face: createScriptedStreamFace({ finishKind: 'error', failure: { message: '上游 503', code: 'UP' } }),
    });
    await expect(
      failed({ goalId: 'g', objective: 'x', completionCriteria: ['c'], existingTaskSubjects: [] }),
    ).rejects.toMatchObject({ code: 'LLM_SEAM_FAILED' });
  });
});
