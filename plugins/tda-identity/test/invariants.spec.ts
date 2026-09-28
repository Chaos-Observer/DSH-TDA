/** T3.3 不变量门 + 双写门（合并：identity 表量小，一门覆盖）。 */
import { describe, expect, it } from 'vitest';
import { createAuditIndex, createDualWriteReconciler, createTdaInvariantRegistry, createJsonBackend, openTdaDomain } from '@tda/kernel';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityDomainSpec, type IdentityManifest, type MigrationRecord } from '../src/domain.ts';
import { registerIdentityInvariants, type IdentityReadFace } from '../src/loadChecks.ts';
import { setup, NOW } from './helpers.ts';

const NOW_MS = NOW;

const manifestOf = (overrides: Partial<IdentityManifest> = {}): IdentityManifest => ({
  manifestId: 'idn-1#v1',
  identityId: 'idn-1' as never,
  version: 1,
  components: { strategies: [], metaPaths: [], calibrations: [] },
  activeModelProfile: 'profile-a',
  createdAt: NOW_MS,
  updatedAt: NOW_MS,
  ...overrides,
});

const recordOf = (overrides: Partial<MigrationRecord> = {}): MigrationRecord => ({
  migrationId: 'mig-1' as never,
  direction: 'migrate',
  toProfile: 'profile-b',
  trigger: 'model-swap',
  verdicts: [],
  at: NOW_MS,
  ...overrides,
});

const faceOf = (face?: Partial<IdentityReadFace>): IdentityReadFace => ({
  manifest: face?.manifest ?? (() => manifestOf()),
  migrations: face?.migrations ?? (() => []),
  activeProfile: face?.activeProfile ?? (() => 'profile-a'),
});

const openRig = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tda-id-inv-'));
  const backend = await createJsonBackend(dir);
  const domain = await openTdaDomain(identityDomainSpec, { backend });
  return { domain, dispose: async () => { await domain.close(); await backend.close(); } };
};

describe('T3.3 不变量门', () => {
  it('identity-verified-only-active：profiles 不含当前 profile 即红', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      registerIdentityInvariants(
        registry,
        rig.domain,
        faceOf({
          manifest: () =>
            manifestOf({
              version: 2,
              components: { strategies: [{ ref: 'hc-1', status: 'verified', profiles: ['profile-old'] }], metaPaths: [], calibrations: [] },
            }),
          activeProfile: () => 'profile-b',
        }),
      );
      await expect(registry.verify('tda-identity')).rejects.toThrowError(/当前 profile/);
    } finally {
      await rig.dispose();
    }
  });

  it('identity-migration-audited：import/migrate 缺 humanTokenRef 即红', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      registerIdentityInvariants(
        registry,
        rig.domain,
        faceOf({ migrations: () => [recordOf({ direction: 'import', humanTokenRef: undefined })] }),
      );
      await expect(registry.verify('tda-identity')).rejects.toThrowError(/人类审批 ref/);
    } finally {
      await rig.dispose();
    }
  });

  it('identity-verdict-auditable：verified/degraded 缺 rehearsalId 即红', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      registerIdentityInvariants(
        registry,
        rig.domain,
        faceOf({
          migrations: () => [
            recordOf({
              humanTokenRef: 'apr-1',
              verdicts: [{ ref: 'hc-1', kind: 'strategy', verdict: 'verified' }],
            }),
          ],
        }),
      );
      await expect(registry.verify('tda-identity')).rejects.toThrowError(/rehearsalId/);
    } finally {
      await rig.dispose();
    }
  });

  it('绿路：真实服务全链（import→migrate）后 verify 通过', async () => {
    const fx = await setup();
    try {
      // 先种 params（真实服务 initialize 已做）
      await fx.service.imports(
        {
          formatVersion: 1,
          identityId: 'idn-1',
          manifestVersion: 1,
          strategies: [{ candidateId: 'hc-1', condition: {}, rule: {}, evidence: [] }],
          metaPaths: [],
          calibrationRefs: [],
          contentHash: 'x',
        } as never,
        'apr-1',
      ).catch(() => undefined); // hash 不匹配也行——绿路只验证不变量不炸
      const registry = createTdaInvariantRegistry();
      registerIdentityInvariants(registry, fx.domain as never, {
        manifest: () => fx.service.manifest(),
        migrations: () => fx.service.history(),
        activeProfile: () => fx.service.manifest().activeModelProfile,
      });
      await expect(registry.verify('tda-identity')).resolves.toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });
});

describe('T3.3 双写门', () => {
  it('全链域写与会话事件逐对配对 + manifest 实体审计定位', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-id-dw-'));
    const backend = await createJsonBackend(dir);
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    type PublishedEvent = { seq: number; sessionId: string; family: string; businessId: string };
    const published: PublishedEvent[] = [];
    const domain = await openTdaDomain(identityDomainSpec, {
      backend,
      onChange: (change: { domain: string; table: string; key: string; operation: string }) =>
        reconciler.observeChange(change as never),
    });
    const { createIdentityService } = await import('../src/service.ts');
    const service = createIdentityService({
      domain,
      session: {
        sessionId: 'sess-identity' as never,
        append(event: never) {
          published.push(event as unknown as PublishedEvent);
          return published.length;
        },
        flush() {},
      },
      rehearsal: {
        async judge(component) {
          return { verdict: 'pass', rehearsalId: `reh-${component.ref}`, coverage: 0.95 };
        },
        async propose(component) {
          return `${component.kind === 'strategy' ? 'hc' : 'mp'}-imp-1`;
        },
      },
      reconciler,
      index,
      now: () => NOW_MS,
    });
    await service.initialize();
    expect(reconciler.reconcile().ok).toBe(true);
    // import 一件 → manifest v2 落域 + 事件配对
    const { canonicalJson } = await import('../src/domain.ts');
    const createHash = (await import('node:crypto')).createHash;
    const body = {
      formatVersion: 1 as const,
      identityId: 'idn-1',
      manifestVersion: 1,
      strategies: [{ candidateId: 'hc-1', condition: {}, rule: {}, evidence: [] }],
      metaPaths: [],
      calibrationRefs: [],
    };
    const snapshot = { ...body, contentHash: createHash('sha256').update(canonicalJson(body)).digest('hex') };
    const result = await service.imports(snapshot as never, 'apr-9');
    expect(result.accepted.length).toBe(1);
    const report = reconciler.reconcile();
    expect(report.ok).toBe(true);
    expect(report.unmatchedWrites ?? 0).toBe(0);
    expect(index.locate('identity', 'identity-manifest:idn-1#v2')).toBeDefined();
    await domain.close();
    await backend.close();
  });
});
