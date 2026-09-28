/**
 * tda-skill-registry 插件出口（T2.2）。
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
import { skillDomainSpec, type SkillTables } from './domain.ts';
import { createSkillService, type SkillDeps, type SkillService } from './service.ts';
import { registerSkillInvariants } from './loadChecks.ts';

export {
  skillDomainSpec,
  SKILL_PARAMS_KEY,
  SKILL_KINDS,
  SKILL_SOURCE_KINDS,
  SKILL_CREDENTIALS,
  SKILL_USE_OUTCOMES,
  DEFAULT_SKILL_PARAMS,
  SkillSchema,
  SkillParamsSchema,
  type SkillTables,
  type Skill,
  type SkillParams,
  type SkillRehearsalRun,
  type SkillUse,
} from './domain.ts';
export {
  SKILL_BUSINESS_PREFIX,
  SKILL_REHEARSAL_BUSINESS_PREFIX,
  SKILL_USE_BUSINESS_PREFIX,
  SKILL_PARAMS_BUSINESS_ID,
  skillPayload,
  skillRehearsalPayload,
  skillUsePayload,
  skillParamsPayload,
} from './events.ts';
export {
  createSkillService,
  type SkillService,
  type SkillDeps,
  type SkillActor,
  type SkillDraft,
  type SkillGovernanceSeam,
  type SkillRehearsalExecutor,
  type SkillMaterializer,
  type SkillInjectItem,
  type SkillLifecycle,
} from './service.ts';
export { registerSkillInvariants, skillInvariantChecks, type SkillInvariantOptions } from './loadChecks.ts';

export interface TdaSkillHandle {
  readonly service: SkillService;
  readonly domain: TdaDomain<SkillTables>;
  dispose(): Promise<void>;
}

export interface TdaSkillPlugin {
  readonly name: string;
  apply(ctx: {
    readonly storage: TdaStorageBackend;
    readonly invariants: TdaInvariantRegistry;
    readonly session: TdaSessionSink;
    readonly deps: Omit<SkillDeps, 'domain' | 'session'>;
  }): Promise<TdaSkillHandle>;
}

export const tdaSkillRegistryPlugin: TdaSkillPlugin = {
  name: 'tda-skill-registry',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(skillDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const service = createSkillService({
      ...ctx.deps,
      domain,
      session: ctx.session,
      reconciler,
      index,
    });
    await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerSkillInvariants(ctx.invariants, domain, { service });
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
