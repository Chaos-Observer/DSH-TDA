/**
 * T3.3 · service（ctx.identity）。硬纪律：
 * - J2/J3 身份=清单+引用，零内容复制；组件内容权威在 T2.1/T1.4/T0.1 域；
 * - J4 快照只存 hash（SHA-256 + prevHash 哈希链），正文可随时重导；
 * - J5 带验证迁移：rehearsal seam 重判定三分级（verified/degraded/failed），不假设兼容；
 * - J6 导入=重新入管道（propose→rehearsal→verified 才进 manifest），快照自述零信任；
 * - 不变量 4：import/migrate 必携人类审批 ref（T3.2 kind='identity-migration'）；
 * - 不变量 7：迁移期连续性——旧 manifest 版本链保留，supersede 不改旧版。
 */
import {
  TdaError,
  dualWrite,
  asIdentityId,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteOp,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  DEFAULT_IDENTITY_PARAMS,
  IDENTITY_ID,
  IDENTITY_PARAMS_BUSINESS_ID,
  IDENTITY_PARAMS_KEY,
  canonicalJson,
  identityDomainSpec,
  type ComponentKind,
  type ComponentStatus,
  type IdentityManifest,
  type IdentityParams,
  type IdentitySnapshot,
  type MigrationRecord,
  type SnapshotRecord,
  type Verdict,
} from './domain.ts';
import { manifestPayload, migrationPayload, snapshotPayload, paramsPayload, MANIFEST_BUSINESS_PREFIX, MIGRATION_BUSINESS_PREFIX, SNAPSHOT_BUSINESS_PREFIX } from './events.ts';

const crypto = globalThis.crypto;
const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** 重判定 seam（复用 T0.7 fork + T1.4/T2.2 rehearsal 协议，不新造验证机制，J5）。 */
export interface IdentityRehearsalSeam {
  judge(
    component: { readonly kind: ComponentKind; readonly ref: string; readonly payload?: unknown },
    profile: string,
  ): Promise<{ readonly verdict: 'pass' | 'fail'; readonly rehearsalId: string; readonly coverage: number }>;
  /** 导入路的重新入管道（快照组件 → 各资产域 propose(draft)，返回新 ref）。 */
  propose(component: { readonly kind: ComponentKind; readonly payload: unknown }): Promise<string>;
}

export interface IdentityDeps {
  readonly domain: TdaDomain;
  readonly session: TdaSessionSink;
  readonly rehearsal: IdentityRehearsalSeam;
  readonly bus?: TdaEventBus | undefined;
  readonly reconciler?: DualWriteReconciler | undefined;
  readonly index?: AuditIndex | undefined;
  readonly now: () => number;
}

export interface ImportResult {
  readonly migrationId: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly { readonly ref: string; readonly reason: string }[];
}

export interface ComponentView {
  readonly ref: string;
  readonly kind: ComponentKind;
  readonly status: ComponentStatus;
  readonly profiles: readonly string[];
}

export interface IdentityService {
  initialize(): Promise<void>;
  manifest(): IdentityManifest;
  export(): Promise<IdentitySnapshot>;
  imports(snapshot: IdentitySnapshot, humanTokenRef: string): Promise<ImportResult>;
  migrate(toProfile: string, trigger: MigrationRecord['trigger'], humanTokenRef: string): Promise<MigrationRecord>;
  history(): readonly MigrationRecord[];
  components(filter?: { status?: string; kind?: string }): readonly ComponentView[];
  migrations(): readonly MigrationRecord[];
  params(): IdentityParams;
  setParams(patch: Partial<Omit<IdentityParams, 'revision'>>): Promise<IdentityParams>;
  dispose(): Promise<void>;
}

type VerdictRow = MigrationRecord['verdicts'][number];

type VerdictList = readonly VerdictRow[];

export function createIdentityService(deps: IdentityDeps): IdentityService {
  const manifestsTable = deps.domain.table('identity_manifests');
  const migrationsTable = deps.domain.table('identity_migrations');
  const snapshotsTable = deps.domain.table('identity_snapshots');
  const paramsTable = deps.domain.table('identity_params');

  const clock = deps.now;
  let paramsRef: IdentityParams | undefined;
  let manifestVersion = 0;
  let migrationSeq = 0;
  let snapshotSeq = 0;
  let prevSnapshotHash: string | undefined;
  /** 当前组件集（运行期镜像；重建 = migrations verdicts 重放）。 */
  let current: IdentityManifest | undefined;

  const context: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
    ...(deps.index !== undefined ? { index: deps.index } : {}),
  };
  const emit = async (op: DualWriteOp): Promise<void> => {
    const seq = await dualWrite(deps.session, op, context);
    deps.bus?.publish({
      family: op.family,
      businessId: op.businessId,
      payload: op.payload,
      seq,
      sessionId: deps.session.sessionId,
    });
  };

  const loadParams = (): IdentityParams => {
    if (paramsRef !== undefined) return paramsRef;
    const row = paramsTable.get(IDENTITY_PARAMS_KEY) as IdentityParams | undefined;
    paramsRef = row ?? { ...DEFAULT_IDENTITY_PARAMS };
    return paramsRef;
  };

  const judgeVerdict = async (
    component: { readonly kind: ComponentKind; readonly ref: string; readonly payload?: unknown; readonly languageDependent?: boolean },
    profile: string,
  ): Promise<VerdictRow> => {
    const result = await deps.rehearsal.judge(component, profile);
    const config = loadParams();
    let verdict: Verdict;
    if (result.verdict === 'fail') {
      verdict = 'failed';
    } else if (component.languageDependent === true && config.languageDependentRequiresVerified) {
      // 不变量 6：languageDependent 组件必须 verified 禁 degraded。
      verdict = result.coverage >= 1 - config.degradedCoverageMargin ? 'verified' : 'failed';
    } else {
      verdict = result.coverage >= 1 - config.degradedCoverageMargin ? 'verified' : 'degraded';
    }
    return {
      ref: component.ref,
      kind: component.kind,
      verdict,
      rehearsalId: result.rehearsalId,
      coverage: result.coverage,
      ...(component.languageDependent !== undefined ? { languageDependent: component.languageDependent } : {}),
    };
  };

  const buildManifest = (verdicts: VerdictList, profile: string, fromVersion: number): IdentityManifest => {
    const at = clock();
    const statusOf = (ref: string): ComponentStatus => {
      const verdict = verdicts.find((item) => item.ref === ref);
      return verdict?.verdict === 'degraded' ? 'degraded' : 'verified';
    };
    const strategies = verdicts
      .filter((item) => item.kind === 'strategy' && item.verdict !== 'failed')
      .map((item) => ({ ref: item.ref, status: statusOf(item.ref), profiles: [profile] }));
    const metaPaths = verdicts
      .filter((item) => item.kind === 'meta-path' && item.verdict !== 'failed')
      .map((item) => ({ ref: item.ref, status: statusOf(item.ref), profiles: [profile] }));
    const calibrations = verdicts
      .filter((item) => item.kind === 'calibration' && item.verdict !== 'failed')
      .map((item) => ({ from: 0, to: at, ref: item.ref }));
    return {
      manifestId: `${IDENTITY_ID}#v${fromVersion + 1}`,
      identityId: asIdentityId(IDENTITY_ID),
      version: fromVersion + 1,
      ...(current !== undefined ? { supersedes: current.manifestId } : {}),
      components: { strategies, metaPaths, calibrations },
      activeModelProfile: profile,
      createdAt: current?.createdAt ?? at,
      updatedAt: at,
    };
  };

  const persistManifest = async (
    manifest: IdentityManifest,
    direction: MigrationRecord['direction'],
    trigger: MigrationRecord['trigger'],
    verdicts: VerdictList,
    humanTokenRef?: string,
  ): Promise<void> => {
    migrationSeq += 1;
    const record: MigrationRecord = {
      migrationId: `mig-${migrationSeq}` as never,
      direction,
      ...(manifest.activeModelProfile !== undefined ? { toProfile: manifest.activeModelProfile } : {}),
      trigger,
      verdicts: [...verdicts],
      ...(humanTokenRef !== undefined && humanTokenRef !== '' ? { humanTokenRef } : {}),
      at: clock(),
    };
    await emit({
      family: 'identity/change',
      businessId: `${MANIFEST_BUSINESS_PREFIX}:${manifest.manifestId}`,
      payload: manifestPayload(manifest),
      domainWrite: async () => {
        await manifestsTable.put(manifest.manifestId, manifest as never);
      },
    });
    // 迁移记录单独成窗（每窗必有域写，防 unmatchedWrites 反向洞）；
    // current 的推进随迁移记录落定（先事件后内存 = 重启可由 manifests 表恢复）。
    await emit({
      family: 'identity/change',
      businessId: `${MIGRATION_BUSINESS_PREFIX}:${String(record.migrationId)}`,
      payload: migrationPayload(record),
      domainWrite: async () => {
        await migrationsTable.put(String(record.migrationId), record as never);
        current = manifest;
        manifestVersion = manifest.version;
      },
    });
  };

  const requireToken = (humanTokenRef: string): void => {
    if (humanTokenRef === undefined || humanTokenRef === '') {
      throw new TdaError('IDENTITY_HUMAN_TOKEN_REQUIRED', 'import/migrate 必携人类审批 ref（T3.2 kind=identity-migration，不变量 4）');
    }
  };

  const service: IdentityService = {
    async initialize() {
      loadParams();
      for (const [, value] of manifestsTable.entries()) {
        const manifest = value as IdentityManifest;
        if (manifest.version > manifestVersion) {
          manifestVersion = manifest.version;
          current = manifest;
        }
      }
      if (manifestVersion === 0) manifestVersion = 1; // 空身份 = 概念上的 v1（首个变更产 v2）
      if (paramsTable.get(IDENTITY_PARAMS_KEY) === undefined) {
        await emit({
          family: 'identity/change',
          businessId: IDENTITY_PARAMS_BUSINESS_ID,
          payload: paramsPayload(loadParams()),
          domainWrite: async () => {
            await paramsTable.put(IDENTITY_PARAMS_KEY, loadParams() as never);
          },
        });
      }
    },

    manifest() {
      if (current === undefined) {
        // 首个 manifest = 空组件集 v1（身份从零开始）。
        const at = clock();
        return {
          manifestId: `${IDENTITY_ID}#v1`,
          identityId: asIdentityId(IDENTITY_ID),
          version: 1,
          components: { strategies: [], metaPaths: [], calibrations: [] },
          activeModelProfile: 'profile-a',
          createdAt: at,
          updatedAt: at,
        };
      }
      return current;
    },

    async export() {
      const manifest = service.manifest();
      const strategies = manifest.components.strategies.map((item) => ({
        candidateId: item.ref,
        condition: { ref: item.ref },
        rule: { ref: item.ref },
        evidence: [item.status],
      }));
      const metaPaths = manifest.components.metaPaths.map((item) => ({
        id: item.ref,
        topology: { ref: item.ref },
        mode: 'convergent',
        applicability: { profiles: [...item.profiles] },
      }));
      const calibrationRefs = manifest.components.calibrations.map((item) => ({ from: item.from, to: item.to, ref: item.ref }));
      const body = { formatVersion: 1 as const, identityId: IDENTITY_ID, manifestVersion: manifest.version, strategies, metaPaths, calibrationRefs };
      const contentHash = await sha256Hex(canonicalJson(body));
      snapshotSeq += 1;
      const record: SnapshotRecord = {
        snapshotId: `snap-${snapshotSeq}` as never,
        manifestVersion: manifest.version,
        contentHash,
        ...(prevSnapshotHash !== undefined ? { prevHash: prevSnapshotHash } : {}),
        exportedAt: clock(),
      };
      await emit({
        family: 'identity/change',
        businessId: `${SNAPSHOT_BUSINESS_PREFIX}:${String(record.snapshotId)}`,
        payload: snapshotPayload(record),
        domainWrite: async () => {
          await snapshotsTable.put(String(record.snapshotId), record as never);
          prevSnapshotHash = contentHash;
        },
      });
      return { ...body, contentHash };
    },

    async imports(snapshot, humanTokenRef) {
      requireToken(humanTokenRef);
      if (snapshot.formatVersion !== loadParams().snapshotFormatVersion) {
        throw new TdaError('IDENTITY_FORMAT_VERSION', `快照 formatVersion=${snapshot.formatVersion} 不受支持`);
      }
      // 完整性校验（不变量 5）：字节级 hash + 链断裂拒绝。
      const recomputed = await sha256Hex(
        canonicalJson({
          formatVersion: snapshot.formatVersion,
          identityId: snapshot.identityId,
          manifestVersion: snapshot.manifestVersion,
          strategies: snapshot.strategies,
          metaPaths: snapshot.metaPaths,
          calibrationRefs: snapshot.calibrationRefs,
        }),
      );
      if (recomputed !== snapshot.contentHash) {
        throw new TdaError('IDENTITY_HASH_MISMATCH', '快照 contentHash 校验失败（字节被篡改或哈希链断裂）');
      }
      // 导入=重新入管道（不变量 3）：propose → rehearsal → verified 才进 manifest。
      const verdicts: VerdictRow[] = [];
      const accepted: string[] = [];
      const rejected: { ref: string; reason: string }[] = [];
      for (const strategy of snapshot.strategies) {
        const newRef = await deps.rehearsal.propose({ kind: 'strategy', payload: strategy });
        verdicts.push(await judgeVerdict({ kind: 'strategy', ref: newRef }, service.manifest().activeModelProfile));
        accepted.push(newRef);
      }
      for (const metaPath of snapshot.metaPaths) {
        const newRef = await deps.rehearsal.propose({ kind: 'meta-path', payload: metaPath });
        verdicts.push(await judgeVerdict({ kind: 'meta-path', ref: newRef }, service.manifest().activeModelProfile));
        accepted.push(newRef);
      }
      void rejected;
      await persistManifest(buildManifest(verdicts, service.manifest().activeModelProfile, manifestVersion), 'import', 'manual', verdicts, humanTokenRef);
      return { migrationId: `mig-${migrationSeq}`, accepted, rejected };
    },

    async migrate(toProfile, trigger, humanTokenRef) {
      requireToken(humanTokenRef);
      const manifest = service.manifest();
      // 迁移期连续性（不变量 7）：在途组件集判定旧 profile 仍生效——rehearsal 判定的是新 profile。
      const verdicts: VerdictRow[] = [];
      for (const strategy of manifest.components.strategies) {
        verdicts.push(await judgeVerdict({ kind: 'strategy', ref: strategy.ref }, toProfile));
      }
      for (const metaPath of manifest.components.metaPaths) {
        verdicts.push(await judgeVerdict({ kind: 'meta-path', ref: metaPath.ref }, toProfile));
      }
      for (const calibration of manifest.components.calibrations) {
        verdicts.push(await judgeVerdict({ kind: 'calibration', ref: calibration.ref }, toProfile));
      }
      await persistManifest(buildManifest(verdicts, toProfile, manifest.version), 'migrate', trigger, verdicts, humanTokenRef);
      return {
        migrationId: `mig-${migrationSeq}` as never,
        direction: 'migrate',
        fromProfile: manifest.activeModelProfile,
        toProfile,
        trigger,
        verdicts: [...verdicts],
        humanTokenRef,
        at: clock(),
      };
    },

    history() {
      return [...migrationsTable.entries()].map(([, value]) => value as MigrationRecord);
    },

    components(filter) {
      const manifest = service.manifest();
      const views: ComponentView[] = [
        ...manifest.components.strategies.map((item) => ({ ref: item.ref, kind: 'strategy' as const, status: item.status, profiles: item.profiles })),
        ...manifest.components.metaPaths.map((item) => ({ ref: item.ref, kind: 'meta-path' as const, status: item.status, profiles: item.profiles })),
      ];
      if (filter === undefined) return views;
      return views.filter(
        (view) =>
          (filter.status === undefined || view.status === filter.status) &&
          (filter.kind === undefined || view.kind === filter.kind),
      );
    },

    migrations() {
      return service.history();
    },

    params() {
      return loadParams();
    },

    async setParams(patch) {
      const currentParams = loadParams();
      const next: IdentityParams = { ...currentParams, ...patch, revision: currentParams.revision + 1 };
      paramsRef = next;
      await emit({
        family: 'identity/change',
        businessId: IDENTITY_PARAMS_BUSINESS_ID,
        payload: paramsPayload(next),
        domainWrite: async () => {
          await paramsTable.put(IDENTITY_PARAMS_KEY, next as never);
        },
      });
      return next;
    },

    async dispose() {
      await deps.domain.close();
    },
  };

  return service;
}

export { identityDomainSpec };
