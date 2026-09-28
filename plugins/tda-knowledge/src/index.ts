/** tda-knowledge 出口：ctx.knowledge 服务 + domain 规格 + 不变量注册（T3.1）。 */
export { createKnowledgeService } from './service.ts';
export type {
  KnowledgeService,
  KnowledgeDeps,
  KnowledgeGraphProvider,
  KnowledgeDistiller,
  KnowledgeTimelineSeam,
  KnowledgeMaintenanceSeam,
  ValidationReport,
} from './service.ts';
export { knowledgeDomainSpec } from './domain.ts';
export type {
  KnowledgeTables,
  KnowledgeEntry,
  KnowledgeEvent,
  KnowledgeRun,
  KnowledgeParams,
  KnowledgeCandidate,
  KnowledgeEdge,
  KnowledgeEntryKind,
  KnowledgeEdgeKind,
  KnowledgeStatus,
  DistillSourceChunk,
} from './domain.ts';
export { DEFAULT_KNOWLEDGE_PARAMS, KNOWLEDGE_ENTRY_KINDS, KNOWLEDGE_EDGE_KINDS, KNOWLEDGE_STATUS } from './domain.ts';
export {
  knowledgeEntryPayload,
  knowledgeRunPayload,
  knowledgeParamsPayload,
  KNOWLEDGE_ENTRY_BUSINESS_PREFIX,
  KNOWLEDGE_RUN_BUSINESS_PREFIX,
} from './events.ts';
export { knowledgeInvariantChecks, registerKnowledgeInvariants, type KnowledgeReadFace } from './loadChecks.ts';
