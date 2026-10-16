/**
 * P5.5 LLM 工序真通道：T4.5 规划分解 / T4.2 需求抽取与树分解三 seam 的
 * StreamFace 适配（装配层注入面——J2"LLM 分解工序由装配层注入"的落点）。
 *
 * 换真继承：face 即 P5.3 的 DshStreamFace（chunk 流经 DSH 真 BlockAssembler
 * 组装，见 tda-subagent-dispatch/dshStreamProvider）——本文件只做三件事：
 *  1. seam 输入 → 结构化 prompt（JSON 输出指令 + 既有任务防重复 + 偏差上下文）；
 *  2. 消费 chunk 流（text JSON 通道）→ `extractJsonObject` 提取（P5.3 真件）；
 *  3. 各自的 zod 权威 schema 校验（tda-planner/tda-intake 导出件——**校验在
 *     调用方质量门之前**，LLM 产物不过 schema 即显式失败，禁假造分解 J2）。
 *
 * 失败面：LLM_SEAM_BAD_JSON（无可提取 JSON）/ LLM_SEAM_INVALID_OUTPUT（schema
 * 不过）/ LLM_SEAM_FAILED（finish=aborted|error）——全部显式 TdaError，上游
 * plan/extract 各自的失败终态接管。
 */
import { z } from 'zod';
import { TdaError } from '@tda/kernel';
import {
  extractJsonObject,
  type DshGenerateOptions,
  type DshStreamChunk,
  type DshStreamFace,
} from 'tda-subagent-dispatch';
import {
  PlannedTaskSchema,
  type DecomposeInput as PlannerDecomposeInput,
  type DecomposeResult as PlannerDecomposeResult,
} from 'tda-planner';
import {
  ProposedGoalNodeSchema,
  type DecomposeInput as TreeDecomposeInput,
  type DecomposeResult as TreeDecomposeResult,
  type DraftExtractInput,
  type DraftExtractResult,
} from 'tda-intake';

// ── 公共面 ──

export interface LlmSeamOptions {
  /** P5.3 StreamFace（scripted face 保留测试面；OpenAI 兼容 wire 走 createOpenAiCompatStreamFace）。 */
  readonly face: DshStreamFace;
  /** generation.provider（缺省 'dsh-stream'）。 */
  readonly provider?: string;
  /** generation.model（缺省 'tda-seam-oneshot'）。 */
  readonly model?: string;
}

/** FNV-1a 16 hex——generation.schemaHash（对指令串确定性，可回放审计）。 */
function schemaHashOf(instruction: string): string {
  let hash = 0xcbf29ce4n;
  const prime = 0x1000193n;
  for (const byte of Buffer.from(instruction, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return `fnv1a-${hash.toString(16).padStart(16, '0')}`;
}

/** 消费 chunk 流的 text 通道（block-start/delta/block-end 由 face 组织）。 */
async function consumeFaceText(face: DshStreamFace, request: DshGenerateOptions): Promise<string> {
  let text = '';
  let failure: string | undefined;
  for await (const chunk of face(request)) {
    const typed = chunk as DshStreamChunk;
    if (typed.type === 'text-delta') text += typed.text;
    else if (typed.type === 'finish' && (typed.reason.kind === 'aborted' || typed.reason.kind === 'error')) {
      failure = typed.reason.kind === 'error' ? typed.reason.failure.message : 'LLM 工序被取消';
    }
  }
  if (failure !== undefined) throw new TdaError('LLM_SEAM_FAILED', failure);
  return text;
}

function parseLlmJson(text: string): unknown {
  const parsed = extractJsonObject(text);
  if (parsed === undefined) {
    throw new TdaError('LLM_SEAM_BAD_JSON', 'LLM 工序输出不含可提取 JSON 对象');
  }
  return parsed;
}

function validateOrThrow<T>(schema: z.ZodType<T>, value: unknown, seam: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new TdaError('LLM_SEAM_INVALID_OUTPUT', `LLM ${seam} 输出不过权威 schema：${detail}`);
  }
  return result.data;
}

// ── T4.5：规划分解 ──

const PLANNER_INSTRUCTION = [
  '你是任务规划器。只输出一个 JSON 对象，形如 {"tasks":[...]}，不输出其他文字。',
  '每个 task 字段：tempId(必填,唯一)、subject(必填)、completionCriteria(必填,非空字符串数组,是任务级证据路径)、',
  'blockedByTempIds(必填,数组)、criteriaRefs(必填,整数数组,引用目标 completionCriteria 的下标,全部下标须被覆盖)、',
  'parentTempId?、description?、alternativeOfTempId?(预案边,指向备选任务)、',
  'contingency?({trigger:{kind:"task-failed",taskTempId},carveOut:0~1},高风险任务必带预案或 noContingencyReason)、',
  'riskHint?("low"|"high")、noContingencyReason?、localPath?、writeScopes?、priority?。',
  '约束：subject 不得与既有任务重复；高风险(riskHint="high")必须有 alternativeOfTempId+contingency 或 noContingencyReason。',
].join('\n');

export function createLlmPlannerDecomposer(options: LlmSeamOptions) {
  const schemaHash = schemaHashOf(PLANNER_INSTRUCTION);
  return async (input: PlannerDecomposeInput): Promise<PlannerDecomposeResult> => {
    const lines = [
      `# 目标 ${input.goalId}`,
      `目标：${input.objective}`,
      '完成标准：',
      ...input.completionCriteria.map((item, index) => `${index}. ${item}`),
    ];
    if (input.existingTaskSubjects.length > 0) {
      lines.push('既有任务主题（禁重复）：', ...input.existingTaskSubjects.map((item) => `- ${item}`));
    }
    if (input.deviation !== undefined) {
      lines.push(`重规划偏差：${JSON.stringify(input.deviation)}`);
    }
    const request: DshGenerateOptions = {
      provider: options.provider ?? 'dsh-stream',
      model: options.model ?? 'tda-seam-oneshot',
      system: PLANNER_INSTRUCTION,
      messages: [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }],
    };
    const text = await consumeFaceText(options.face, request);
    const parsed = parseLlmJson(text);
    const record = parsed as { tasks?: unknown };
    const tasks = validateOrThrow(z.array(PlannedTaskSchema), record.tasks, '规划分解');
    return {
      tasks,
      generation: {
        provider: request.provider,
        model: request.model,
        schemaHash,
      },
    };
  };
}

// ── T4.2：需求抽取 ──

const EXTRACT_INSTRUCTION = [
  '你是需求整理器。只输出一个 JSON 对象，不输出其他文字。',
  '字段：objective(必填,一句话结构化目标陈述,不得照抄原文全文)、',
  'completionCriteria(必填,非空数组,可核对的完成标准)、constraints(必填,数组,约束条件,可为空数组)、',
  'budgetHint?(可选,{tokens?,wallClockMs?,attentionUnits?})。',
].join('\n');

const DraftExtractResultSchema = z.object({
  objective: z.string().min(1),
  completionCriteria: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string()),
  budgetHint: z
    .object({
      tokens: z.number().optional(),
      wallClockMs: z.number().optional(),
      attentionUnits: z.number().optional(),
    })
    .optional(),
});

export function createLlmIntakeExtractor(options: LlmSeamOptions & {
  /** 原文解析器（装配层桥：timeline 只读回读——J2 原文只进本工序 prompt，不进主上下文）。 */
  resolveRawText: (rawEntryId: string) => Promise<string> | string;
}) {
  const schemaHash = schemaHashOf(EXTRACT_INSTRUCTION);
  return async (input: DraftExtractInput): Promise<DraftExtractResult> => {
    const rawText = await options.resolveRawText(input.rawEntryId);
    const request: DshGenerateOptions = {
      provider: options.provider ?? 'dsh-stream',
      model: options.model ?? 'tda-seam-oneshot',
      system: EXTRACT_INSTRUCTION,
      messages: [{ role: 'user', content: [{ type: 'text', text: `# 原始需求\n${rawText}` }] }],
    };
    const text = await consumeFaceText(options.face, request);
    const parsed = parseLlmJson(text);
    const value = validateOrThrow(DraftExtractResultSchema, parsed, '需求抽取');
    return {
      objective: value.objective,
      completionCriteria: value.completionCriteria,
      constraints: value.constraints,
      ...(value.budgetHint !== undefined
        ? {
          budgetHint: {
            ...(value.budgetHint.tokens !== undefined ? { tokens: value.budgetHint.tokens } : {}),
            ...(value.budgetHint.wallClockMs !== undefined ? { wallClockMs: value.budgetHint.wallClockMs } : {}),
            ...(value.budgetHint.attentionUnits !== undefined ? { attentionUnits: value.budgetHint.attentionUnits } : {}),
          },
        }
        : {}),
      generation: { provider: request.provider, model: request.model, schemaHash },
    };
  };
}

// ── T4.2：目标树分解（Lead 工序，schema 白名单 goal-tree-proposal）──

const TREE_INSTRUCTION = [
  '你是目标树分解器。只输出一个 JSON 对象，形如 {"nodes":[...]}，不输出其他文字。',
  '每个 node 字段：tempId(必填,如 "g1"/"g1.1")、objective(必填)、completionCriteria(必填,非空数组)、',
  'parentTempId?(子节点挂父)、budget?、maxGoalRounds?、pinned?(来自约束)。',
  '约束：恰好一个根（无 parentTempId）；无任何任务指令字段（本工序只产目标树）。',
].join('\n');

export function createLlmIntakeTreeDecomposer(options: LlmSeamOptions) {
  const schemaHash = schemaHashOf(TREE_INSTRUCTION);
  return async (input: TreeDecomposeInput): Promise<TreeDecomposeResult> => {
    const lines = [
      `目标：${input.objective}`,
      '完成标准：',
      ...input.completionCriteria.map((item) => `- ${item}`),
      ...(input.constraints.length > 0 ? ['约束：', ...input.constraints.map((item) => `- ${item}`)] : []),
    ];
    const request: DshGenerateOptions = {
      provider: options.provider ?? 'dsh-stream',
      model: options.model ?? 'tda-seam-oneshot',
      system: TREE_INSTRUCTION,
      messages: [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }],
    };
    const text = await consumeFaceText(options.face, request);
    const parsed = parseLlmJson(text);
    const record = parsed as { nodes?: unknown };
    const nodes = validateOrThrow(z.array(ProposedGoalNodeSchema), record.nodes, '树分解');
    return {
      nodes,
      generation: { provider: request.provider, model: request.model, schemaHash },
    };
  };
}
