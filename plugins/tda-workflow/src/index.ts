/**
 * tda-workflow 插件出口（T2.5）。
 */
import {
  createAuditIndex,
  createDualWriteReconciler,
  openTdaDomain,
  registerTdaInvariants,
  type TdaDomain,
  type TdaInvariantRegistry,
  type TdaSessionSink,
  type TdaStorageBackend,
} from '@tda/kernel';
import { workflowDomainSpec, type WorkflowTables } from './domain.ts';
import { createWorkflowService, type WorkflowDeps, type WorkflowService } from './service.ts';
import { registerWorkflowInvariants } from './loadChecks.ts';

export {
  workflowDomainSpec,
  WORKFLOW_PARAMS_KEY,
  ASSERTION_KINDS,
  STEP_KINDS,
  RUN_STATUSES,
  EVENT_KINDS,
  DEFAULT_PARAMS,
  scriptHashOf,
  DefinitionSchema,
  RunSchema,
  EventSchema,
  ParamsSchema,
  WorkflowMetaSchema,
  type WorkflowTables,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowEvent,
  type WorkflowParams,
  type WorkflowMeta,
  type Assertion,
  type Bound,
} from './domain.ts';
export {
  WORKFLOW_DEF_BUSINESS_PREFIX,
  WORKFLOW_RUN_BUSINESS_PREFIX,
  WORKFLOW_EVENT_BUSINESS_PREFIX,
  WORKFLOW_PARAMS_BUSINESS_ID,
  workflowDefPayload,
  workflowRunPayload,
  workflowEventPayload,
  workflowParamsPayload,
} from './events.ts';
export {
  createWorkflowService,
  type WorkflowService,
  type WorkflowDeps,
  type WorkflowActor,
  type WorkflowDefinitionDraft,
  type WorkflowGovernanceSeam,
  type WorkflowChecks,
  type WorkflowStepExecutor,
  type WorkflowPlanner,
  type ValidationReport,
} from './service.ts';
export { registerWorkflowInvariants, workflowInvariantChecks, type WorkflowInvariantOptions } from './loadChecks.ts';

export interface TdaWorkflowHandle {
  readonly service: WorkflowService;
  readonly domain: TdaDomain<WorkflowTables>;
  dispose(): Promise<void>;
}

export interface TdaWorkflowPlugin {
  readonly name: string;
  apply(ctx: {
    readonly storage: TdaStorageBackend;
    readonly invariants: TdaInvariantRegistry;
    readonly session: TdaSessionSink;
    readonly deps: Omit<WorkflowDeps, 'domain' | 'session'>;
  }): Promise<TdaWorkflowHandle>;
}

export const tdaWorkflowPlugin: TdaWorkflowPlugin = {
  name: 'tda-workflow',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(workflowDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const service = createWorkflowService({
      ...ctx.deps,
      domain,
      session: ctx.session,
      reconciler,
      index,
    });
    await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerWorkflowInvariants(ctx.invariants, domain, { service });
    return {
      service,
      domain,
      async dispose() {
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
