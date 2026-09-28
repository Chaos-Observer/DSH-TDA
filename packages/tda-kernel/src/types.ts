/**
 * TDA 内核共享类型：品牌化 ID、JSON 边界值、错误基类。
 *
 * 品牌化 ID 让不同业务线的 id 在编译期不可互换，
 * 防止把 task-1 误当 goal-1 传入（运行期仍为普通字符串，零成本）。
 */

declare const TDA_BRAND: unique symbol;

/** 品牌类型：结构上等价于 T，静态类型带品牌 B，禁止跨品牌赋值。 */
export type Brand<T, B extends string> = T & { readonly [TDA_BRAND]: B };

export type SessionId = Brand<string, 'SessionId'>;
export type GoalId = Brand<string, 'GoalId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type EntryId = Brand<string, 'EntryId'>;
export type DispatchId = Brand<string, 'DispatchId'>;
export type ScanId = Brand<string, 'ScanId'>;
export type PinId = Brand<string, 'PinId'>;
// P1 扩展（T1.1–T1.5）：认知资产与治理对象的品牌 id。
export type GovActionId = Brand<string, 'GovActionId'>;
export type TransitionId = Brand<string, 'TransitionId'>;
export type PredictionId = Brand<string, 'PredictionId'>;
export type MismatchId = Brand<string, 'MismatchId'>;
export type MetaPathId = Brand<string, 'MetaPathId'>;
export type RehearsalId = Brand<string, 'RehearsalId'>;
export type DriftSnapshotId = Brand<string, 'DriftSnapshotId'>;
// P2（T2.1–T2.6）。
export type CoachReviewId = Brand<string, 'CoachReviewId'>;
export type CoachCandidateId = Brand<string, 'CoachCandidateId'>;
export type SkillId = Brand<string, 'SkillId'>;
export type SkillUseId = Brand<string, 'SkillUseId'>;
export type MaintenanceProposalId = Brand<string, 'MaintenanceProposalId'>;
export type MaintenanceActionId = Brand<string, 'MaintenanceActionId'>;
export type MaintenanceReportId = Brand<string, 'MaintenanceReportId'>;
export type WorkflowDefId = Brand<string, 'WorkflowDefId'>;
export type WorkflowRunId = Brand<string, 'WorkflowRunId'>;
export type WorkflowEventId = Brand<string, 'WorkflowEventId'>;
export type ScoutRunId = Brand<string, 'ScoutRunId'>;
export type ScoutEventId = Brand<string, 'ScoutEventId'>;
// P3（T3.1–T3.4）
export type KnowledgeEntryId = Brand<string, 'KnowledgeEntryId'>;
export type KnowledgeRunId = Brand<string, 'KnowledgeRunId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type AttentionId = Brand<string, 'AttentionId'>;
export type IdentityId = Brand<string, 'IdentityId'>;
export type MigrationId = Brand<string, 'MigrationId'>;
export type SnapshotId = Brand<string, 'SnapshotId'>;
export type CaseId = Brand<string, 'CaseId'>;
export type RedTeamRunId = Brand<string, 'RedTeamRunId'>;
export type FindingId = Brand<string, 'FindingId'>;

export const asSessionId = (value: string): SessionId => value as SessionId;
export const asGoalId = (value: string): GoalId => value as GoalId;
export const asTaskId = (value: string): TaskId => value as TaskId;
export const asEntryId = (value: string): EntryId => value as EntryId;
export const asDispatchId = (value: string): DispatchId => value as DispatchId;
export const asScanId = (value: string): ScanId => value as ScanId;
export const asPinId = (value: string): PinId => value as PinId;
export const asGovActionId = (value: string): GovActionId => value as GovActionId;
export const asTransitionId = (value: string): TransitionId => value as TransitionId;
export const asPredictionId = (value: string): PredictionId => value as PredictionId;
export const asMismatchId = (value: string): MismatchId => value as MismatchId;
export const asMetaPathId = (value: string): MetaPathId => value as MetaPathId;
export const asRehearsalId = (value: string): RehearsalId => value as RehearsalId;
export const asDriftSnapshotId = (value: string): DriftSnapshotId => value as DriftSnapshotId;
export const asCoachReviewId = (value: string): CoachReviewId => value as CoachReviewId;
export const asCoachCandidateId = (value: string): CoachCandidateId => value as CoachCandidateId;
export const asSkillId = (value: string): SkillId => value as SkillId;
export const asSkillUseId = (value: string): SkillUseId => value as SkillUseId;
export const asMaintenanceProposalId = (value: string): MaintenanceProposalId =>
  value as MaintenanceProposalId;
export const asMaintenanceActionId = (value: string): MaintenanceActionId =>
  value as MaintenanceActionId;
export const asMaintenanceReportId = (value: string): MaintenanceReportId =>
  value as MaintenanceReportId;
export const asWorkflowDefId = (value: string): WorkflowDefId => value as WorkflowDefId;
export const asWorkflowRunId = (value: string): WorkflowRunId => value as WorkflowRunId;
export const asWorkflowEventId = (value: string): WorkflowEventId => value as WorkflowEventId;
export const asScoutRunId = (value: string): ScoutRunId => value as ScoutRunId;
export const asScoutEventId = (value: string): ScoutEventId => value as ScoutEventId;
export const asKnowledgeEntryId = (value: string): KnowledgeEntryId => value as KnowledgeEntryId;
export const asKnowledgeRunId = (value: string): KnowledgeRunId => value as KnowledgeRunId;
export const asApprovalId = (value: string): ApprovalId => value as ApprovalId;
export const asAttentionId = (value: string): AttentionId => value as AttentionId;
export const asIdentityId = (value: string): IdentityId => value as IdentityId;
export const asMigrationId = (value: string): MigrationId => value as MigrationId;
export const asSnapshotId = (value: string): SnapshotId => value as SnapshotId;
export const asCaseId = (value: string): CaseId => value as CaseId;
export const asRedTeamRunId = (value: string): RedTeamRunId => value as RedTeamRunId;
export const asFindingId = (value: string): FindingId => value as FindingId;

/** domain 记录单调修订号；CAS 以此检测并发覆写。 */
export type Revision = number;

/** log-only 事件序号；session 内严格递增，audit_index 以其定位。 */
export type Seq = number;

/** JSON 可序列化值：落盘与事件载荷的边界类型。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** TDA 错误基类：携带机器可读 code；name 取具体子类名。 */
export class TdaError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}
