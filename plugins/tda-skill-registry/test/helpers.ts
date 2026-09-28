/**
 * T2.2 测试脚手架：假治理面（记录动作 + lifecycle 映射）/ 假 rehearsal 执行器
 * （可编排出/覆盖率）/ 假物化器（记录 SKILL.md 写/删）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJsonBackend,
  openTdaDomain,
  type SessionId,
  type TdaDomain,
  type TdaLogEvent,
  type TdaSessionSink,
  type TdaStorageBackend,
} from '@tda/kernel';
import { skillDomainSpec, type SkillTables } from '../src/domain.ts';
import { createSkillService, type SkillGovernanceSeam, type SkillLifecycle, type SkillService } from '../src/service.ts';

export type SequencedLogEvent = TdaLogEvent & { readonly seq: number; readonly sessionId: SessionId };

export function createMemorySink(sessionId = 'sess-skill'): TdaSessionSink & { readonly events: SequencedLogEvent[] } {
  const id = sessionId as SessionId;
  const events: SequencedLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: id,
    append(event: TdaLogEvent) {
      seq += 1;
      events.push({ ...event, seq, sessionId: id });
      return seq;
    },
    flush() {},
    events,
  };
}

export interface FakeGovernanceState {
  readonly seam: SkillGovernanceSeam;
  readonly lifecycles: Map<string, SkillLifecycle>;
  readonly actions: { assetId: string; action: string; reason?: { kind: string; detail: string } }[];
}

export function createFakeGovernance(): FakeGovernanceState {
  const lifecycles = new Map<string, SkillLifecycle>();
  const actions: { assetId: string; action: string; reason?: { kind: string; detail: string } }[] = [];
  return {
    lifecycles,
    actions,
    seam: {
      lifecycleOf(assetId) {
        return lifecycles.get(assetId);
      },
      async promoteAsset(_actor, assetId, _assetKind, _note) {
        actions.push({ assetId, action: 'promote' });
        lifecycles.set(assetId, 'validating');
        return { ok: true };
      },
      async consolidate(_actor, assetId, _assetKind) {
        actions.push({ assetId, action: 'consolidate' });
        lifecycles.set(assetId, 'consolidated');
        return { ok: true };
      },
      async retire(_actor, assetId, reason, _opts, _assetKind) {
        actions.push({ assetId, action: 'retire', reason: { ...reason } });
        lifecycles.set(assetId, 'retired');
        return { ok: true };
      },
    },
  };
}

export interface FakeExecutorState {
  readonly seam: {
    run(input: { skill: unknown; taskId: string }): Promise<{
      childSessionId: string;
      boundary: { sessionId: string; eventKind: string; seq: number };
      outcome: 'success' | 'failure';
      coverage: number;
    }>;
  };
  /** 依次出队的脚本（缺省 success+0.9）。 */
  script: { outcome: 'success' | 'failure'; coverage: number }[];
}

export function createFakeExecutor(): FakeExecutorState {
  const script: { outcome: 'success' | 'failure'; coverage: number }[] = [];
  let n = 0;
  return {
    script,
    seam: {
      async run(input) {
        const step = script.shift() ?? { outcome: 'success' as const, coverage: 0.9 };
        n += 1;
        void input;
        return {
          childSessionId: `child-${n}`,
          boundary: { sessionId: 'sess-skill', eventKind: 'session/start', seq: n },
          outcome: step.outcome,
          coverage: step.coverage,
        };
      },
    },
  };
}

export interface SkillFixture {
  readonly service: SkillService;
  readonly domain: TdaDomain<SkillTables>;
  readonly governance: FakeGovernanceState;
  readonly executor: FakeExecutorState;
  readonly materialized: { written: string[]; removed: string[] };
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly backend: TdaStorageBackend;
  readonly dir: string;
  dispose(): Promise<void>;
}

export const NOW = 1_790_000_000_000;

export async function setup(options: { readonly withMaterializer?: boolean } = {}): Promise<SkillFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-skill-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(skillDomainSpec, { backend });
  const governance = createFakeGovernance();
  const executor = createFakeExecutor();
  const materialized = { written: [] as string[], removed: [] as string[] };
  const sink = createMemorySink();
  const service = createSkillService({
    domain,
    session: sink,
    governance: governance.seam,
    executor: executor.seam,
    ...(options.withMaterializer === true
      ? {
          materializer: {
            async write(skill) {
              materialized.written.push(`${skill.name}.md`);
            },
            async remove(skill) {
              materialized.removed.push(`${skill.name}.md`);
            },
          },
        }
      : {}),
    now: () => NOW,
  });
  await service.initialize();
  return {
    service,
    domain,
    governance,
    executor,
    materialized,
    sink,
    backend,
    dir,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

export const draftOf = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  summary: `${name} 的摘要`,
  kind: 'procedure' as const,
  procedure: {
    steps: [{ action: 'read:read' }, { action: 'edit:write' }],
    prerequisites: [] as string[],
  },
  applicability: { taskClasses: ['tda'], stages: ['executing'] as const, problemFeatures: [] },
  source: { kind: 'human' as const, refs: [] },
  credential: 'user-original' as const,
  ...overrides,
});
