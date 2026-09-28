/**
 * T2.3 测试脚手架：假信号源（可变资产行）/ 假治理面（记录动作 + lifecycle）。
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
import { maintenanceDomainSpec, type MaintenanceTables } from '../src/domain.ts';
import { createMaintenanceService, type AssetSignalRow, type MaintenanceService } from '../src/service.ts';

export type SequencedLogEvent = TdaLogEvent & { readonly seq: number; readonly sessionId: SessionId };

export function createMemorySink(sessionId = 'sess-maint'): TdaSessionSink & { readonly events: SequencedLogEvent[] } {
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
  readonly seam: {
    consolidate(actor: unknown, assetId: string, assetKind?: string): Promise<unknown>;
    retire(actor: unknown, assetId: string, reason: { kind: string; detail: string }, opts?: unknown, assetKind?: string): Promise<unknown>;
    restore(actor: unknown, assetId: string, assetKind?: string): Promise<unknown>;
    proposeInvalidate(actor: unknown, assetId: string, reason: string, opts?: unknown): Promise<unknown>;
    lifecycleOf(assetId: string, assetKind?: string): string | undefined;
    actions(assetId?: string): readonly { id: string; assetId: string; action: string }[];
  };
  readonly lifecycles: Map<string, string>;
  readonly actionsLog: { id: string; assetId: string; action: string }[];
  readonly calls: string[];
}

export function createFakeGovernance(): FakeGovernanceState {
  const lifecycles = new Map<string, string>();
  const actionsLog: { id: string; assetId: string; action: string }[] = [];
  const calls: string[] = [];
  let n = 0;
  return {
    lifecycles,
    actionsLog,
    calls,
    seam: {
      async consolidate(_actor, assetId) {
        calls.push(`consolidate:${assetId}`);
        n += 1;
        actionsLog.push({ id: `gov-${n}`, assetId, action: 'consolidate' });
        lifecycles.set(assetId, 'consolidated');
        return { id: `gov-${n}` };
      },
      async retire(_actor, assetId, reason) {
        calls.push(`retire:${assetId}:${reason.kind}`);
        n += 1;
        actionsLog.push({ id: `gov-${n}`, assetId, action: 'retire' });
        lifecycles.set(assetId, 'retired');
        return { id: `gov-${n}` };
      },
      async restore(_actor, assetId) {
        calls.push(`restore:${assetId}`);
        n += 1;
        actionsLog.push({ id: `gov-${n}`, assetId, action: 'restore' });
        lifecycles.set(assetId, 'consolidated');
        return { id: `gov-${n}` };
      },
      async proposeInvalidate(_actor, assetId, reason) {
        calls.push(`invalidate:${assetId}:${reason}`);
        n += 1;
        actionsLog.push({ id: `gov-${n}`, assetId, action: 'propose-invalidate' });
        return { id: `gov-${n}` };
      },
      lifecycleOf(assetId) {
        return lifecycles.get(assetId);
      },
      actions(assetId) {
        return assetId !== undefined ? actionsLog.filter((action) => action.assetId === assetId) : [...actionsLog];
      },
    },
  };
}

export interface MaintenanceFixture {
  readonly service: MaintenanceService;
  readonly domain: TdaDomain<MaintenanceTables>;
  readonly governance: FakeGovernanceState;
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly backend: TdaStorageBackend;
  readonly dir: string;
  setAssets(rows: readonly AssetSignalRow[]): void;
  setConflicts(rows: readonly { assetKind: AssetSignalRow['assetKind']; assetId: string; withIds: readonly string[] }[]): void;
  setAthleteActive(active: boolean): void;
  setCoachCandidates(rows: readonly { id: string; risk: string; targetRef?: string; assetKind?: string }[]): void;
  dispose(): Promise<void>;
}

export const NOW = 1_790_000_000_000;

export async function setup(options: { readonly now?: () => number } = {}): Promise<MaintenanceFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-maint-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(maintenanceDomainSpec, { backend });
  const governance = createFakeGovernance();
  const sink = createMemorySink();

  let assets: readonly AssetSignalRow[] = [];
  let conflicts: readonly { assetKind: AssetSignalRow['assetKind']; assetId: string; withIds: readonly string[] }[] = [];
  let athleteActive = false;
  let coachCandidates: readonly { id: string; risk: string; targetRef?: string; assetKind?: string }[] = [];

  const service = createMaintenanceService({
    domain,
    session: sink,
    signals: {
      assets: () => assets,
      conflicts: () => conflicts,
      isAthleteActive: () => athleteActive,
    },
    governance: governance.seam,
    coachCandidates: () => coachCandidates,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  await service.initialize();
  return {
    service,
    domain,
    governance,
    sink,
    backend,
    dir,
    setAssets(rows) {
      assets = rows;
    },
    setConflicts(rows) {
      conflicts = rows;
    },
    setAthleteActive(active) {
      athleteActive = active;
    },
    setCoachCandidates(rows) {
      coachCandidates = rows;
    },
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

export const assetRow = (overrides: Partial<AssetSignalRow> & { assetId: string }): AssetSignalRow => ({
  assetKind: 'memory',
  lifecycle: 'validating',
  reuseCount: 0,
  verifyCount: 0,
  taskIds: [],
  ...overrides,
});
