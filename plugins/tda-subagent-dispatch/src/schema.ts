/**
 * T0.5 §3.2 结论 outputSchema 白名单 + 最小 JSON-Schema 子集校验器。
 *
 * 结构性硬条款（J4 / 不变量 3）：schema 白名单字段**不含任何任务指令类字段**
 * ——返回是数据流，任务定义/编排是控制流（§5.4）。字段名一旦出现
 * status/owner/complete/taskId/… 等指令词，即视为"返回即执行"（PTE 注入）
 * 的直通路径，构造期直接拒（`assertConclusionSchema`）。
 *
 * 校验器只实现 DSH `assertObjectJsonSchema` 子集所需的关键字：
 * type / required / properties / additionalProperties:false / items /
 * minimum / maximum / enum / minItems。**未知键一律拒绝**
 * （additionalProperties:false 的等价语义），避免"多带字段绕白名单"。
 */
import { TdaError, type JsonValue } from '@tda/kernel';
import type { DispatchSchemaId } from './domain.ts';

/** object-rooted JSON Schema（子集）。 */
export interface ObjectJsonSchema {
  readonly type: 'object';
  readonly required?: readonly string[];
  readonly properties: Readonly<Record<string, JsonSchemaNode>>;
  readonly additionalProperties: false;
}

export type JsonSchemaNode =
  | { readonly type: 'string'; readonly enum?: readonly string[] }
  | { readonly type: 'number'; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: 'boolean' }
  | { readonly type: 'array'; readonly items: JsonSchemaNode; readonly minItems?: number }
  | {
      readonly type: 'object';
      readonly required?: readonly string[];
      readonly properties: Readonly<Record<string, JsonSchemaNode>>;
      readonly additionalProperties: false;
    };

const STRING_ARRAY: JsonSchemaNode = { type: 'array', items: { type: 'string' } };

/** sidekick-conclusion：结构化发现 + 证据 + 风险 + 建议 + 置信度 + 未完成。 */
export const SIDEKICK_CONCLUSION_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  required: ['findings', 'confidence'],
  properties: {
    findings: STRING_ARRAY,
    evidence: STRING_ARRAY,
    risks: STRING_ARRAY,
    recommendation: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    unfinished: STRING_ARRAY,
  },
  additionalProperties: false,
};

/** lead-conclusion = sidekick-conclusion + verdict + critiques（§4 critic 模式载体）。 */
export const LEAD_CONCLUSION_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  required: ['findings', 'confidence', 'verdict'],
  properties: {
    ...SIDEKICK_CONCLUSION_SCHEMA.properties,
    verdict: { type: 'string', enum: ['approve', 'revise', 'reject'] },
    critiques: {
      type: 'array',
      items: {
        type: 'object',
        required: ['angle', 'issue', 'severity'],
        properties: {
          angle: { type: 'string' },
          issue: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

/**
 * sidekick-workspace-annotation（T0.6 §4.2：标注结论 schema = sidekick-conclusion
 * + 文件标注扩展字段，P0 内嵌）。
 *
 * 新增字段全是**数据**（文件路径/角色/可信度/边），不含任务指令类词汇——
 * `assertConclusionSchema` 的指令词黑名单对其同样生效（见 schemaFieldNames 视角）。
 */
export const SIDEKICK_WORKSPACE_ANNOTATION_SCHEMA: ObjectJsonSchema = {

    type: 'object',
    required: ['findings', 'confidence', 'files'],
    properties: {
      ...SIDEKICK_CONCLUSION_SCHEMA.properties,
      /** T0.6 §4.2：文件角色/可信度标注（数据，非指令）。 */
      files: {
        type: 'array',
        items: {
          type: 'object',
          required: ['path', 'role', 'credibilityHint'],
          properties: {
            path: { type: 'string' },
            role: {
              type: 'string',
              enum: ['doc', 'code', 'config', 'data', 'artifact', 'unknown'],
            },
            credibilityHint: {
              type: 'string',
              enum: ['authoritative-likely', 'draft-likely', 'unknown'],
            },
          },
          additionalProperties: false,
        },
      },
      /** 图谱边（显性边由本地解析、隐性边由模型启发式给出并自评 confidence）。 */
      edges: {
        type: 'array',
        items: {
          type: 'object',
          required: ['from', 'to', 'kind', 'confidence'],
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            kind: { type: 'string', enum: ['depends-on', 'related-to', 'supersedes-file'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidence: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      notes: STRING_ARRAY,
    },
    additionalProperties: false,
};
export const CONCLUSION_SCHEMAS: Record<DispatchSchemaId, ObjectJsonSchema> = {
  'sidekick-conclusion': SIDEKICK_CONCLUSION_SCHEMA,
  'lead-conclusion': LEAD_CONCLUSION_SCHEMA,
  'sidekick-workspace-annotation': SIDEKICK_WORKSPACE_ANNOTATION_SCHEMA,
};

/**
 * 指令类字段名黑名单（J4 反向自检）：schema 里出现任一即拒。
 * 这些词是"控制流"词汇，一旦成为可回传字段，子代理即可用返回值改写任务定义。
 */
export const FORBIDDEN_SCHEMA_FIELDS: readonly string[] = [
  'status',
  'state',
  'phase',
  'stage',
  'owner',
  'ownerId',
  'taskId',
  'goalId',
  'complete',
  'completed',
  'claim',
  'assign',
  'description',
  'objective',
  'instructions',
  'command',
  'action',
  'todo',
  'dispatch',
];

/** 收集 schema 全部字段名（含嵌套 object 的 properties）。 */
export function schemaFieldNames(schema: JsonSchemaNode, out: string[] = []): string[] {
  if (schema.type !== 'object') {
    if (schema.type === 'array') schemaFieldNames(schema.items, out);
    return out;
  }
  for (const [key, node] of Object.entries(schema.properties)) {
    out.push(key);
    schemaFieldNames(node, out);
  }
  return out;
}

/** 构造期/加载期校验：object-rooted、白名单无指令字段、体积合法。 */
export function assertConclusionSchema(schemaId: DispatchSchemaId, schema: ObjectJsonSchema): void {
  if (schema.type !== 'object') {
    throw new TdaError('DISPATCH_SCHEMA_INVALID', `outputSchema 必须 object-rooted（${schemaId}）`);
  }
  if (schema.additionalProperties !== false) {
    throw new TdaError('DISPATCH_SCHEMA_INVALID', `outputSchema 必带 additionalProperties:false（${schemaId}）`);
  }
  const names = schemaFieldNames(schema);
  for (const name of names) {
    if (FORBIDDEN_SCHEMA_FIELDS.includes(name)) {
      throw new TdaError(
        'DISPATCH_SCHEMA_INVALID',
        `outputSchema 字段 "${name}" 属任务指令类词汇（${schemaId}）——` +
          '返回是数据流，不得可回传任务定义（§5.4 控制流/数据流分离）',
      );
    }
  }
}

export interface ConclusionValidation {
  readonly ok: boolean;
  readonly value?: JsonValue;
  readonly errors: readonly string[];
}

const validateNode = (node: JsonSchemaNode, value: unknown, path: string, errors: string[]): void => {
  switch (node.type) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path} 期望 string，实为 ${typeof value}`);
        return;
      }
      if (node.enum !== undefined && !node.enum.includes(value)) {
        errors.push(`${path} 取值 "${value}" 不在枚举 [${node.enum.join(', ')}] 内`);
      }
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push(`${path} 期望 number，实为 ${typeof value}`);
        return;
      }
      if (node.minimum !== undefined && value < node.minimum) errors.push(`${path} 小于下界 ${node.minimum}`);
      if (node.maximum !== undefined && value > node.maximum) errors.push(`${path} 大于上界 ${node.maximum}`);
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push(`${path} 期望 boolean，实为 ${typeof value}`);
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path} 期望 array，实为 ${typeof value}`);
        return;
      }
      if (node.minItems !== undefined && value.length < node.minItems) {
        errors.push(`${path} 元素数 ${value.length} 少于 minItems ${node.minItems}`);
      }
      value.forEach((item, index) => validateNode(node.items, item, `${path}[${index}]`, errors));
      return;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path} 期望 object，实为 ${Array.isArray(value) ? 'array' : typeof value}`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const key of node.required ?? []) {
        if (!(key in record)) errors.push(`${path} 缺少必填字段 "${key}"`);
      }
      for (const [key, child] of Object.entries(record)) {
        const childSchema = node.properties[key];
        if (childSchema === undefined) {
          // additionalProperties:false 语义：白名单外字段一律拒（防"多带字段"
          // 夹带任务指令，J4 的构造侧防线在这里落到运行期）
          errors.push(`${path} 含白名单外字段 "${key}"（additionalProperties:false）`);
          continue;
        }
        validateNode(childSchema, child, `${path}.${key}`, errors);
      }
      return;
    }
  }
};

/** provider 回传 structured 的 schema 校验结果（§2.1：失败即 conclusion-partial/error）。 */
export function validateConclusion(schemaId: DispatchSchemaId, structured: unknown): ConclusionValidation {
  const schema = CONCLUSION_SCHEMAS[schemaId];
  const errors: string[] = [];
  validateNode(schema, structured, '$', errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: structured as JsonValue, errors: [] };
}

/** 结论摘要视图（T0.4 injection 区渲染输入；主上下文只放摘要 + entryId 引用）。 */
export interface ConclusionView {
  readonly taskId: string;
  readonly role: 'sidekick' | 'lead';
  readonly outcome: 'conclusion' | 'conclusion-partial';
  readonly findings: readonly string[];
  readonly confidence: number;
  readonly entryId?: string;
}

/** 从已过校验的结论值提取摘要视图（findings 截前 3 条，§4.2）。 */
export function conclusionView(options: {
  readonly taskId: string;
  readonly role: 'sidekick' | 'lead';
  readonly outcome: 'conclusion' | 'conclusion-partial';
  readonly value: unknown;
  readonly entryId?: string | undefined;
}): ConclusionView {
  const record = (options.value ?? {}) as { findings?: unknown; confidence?: unknown };
  const findings = Array.isArray(record.findings)
    ? record.findings.filter((item): item is string => typeof item === 'string').slice(0, 3)
    : [];
  const confidence = typeof record.confidence === 'number' ? record.confidence : 0;
  return {
    taskId: options.taskId,
    role: options.role,
    outcome: options.outcome,
    findings,
    confidence,
    ...(options.entryId !== undefined ? { entryId: options.entryId } : {}),
  };
}
