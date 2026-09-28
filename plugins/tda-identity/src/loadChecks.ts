/**
 * T3.3 · 加载期不变量检查（§4.1 核心 5 条）。
 */
import { tdaPluginInstaller, type TdaDomain, type TdaInvariantCheck, type TdaInvariantRegistry } from '@tda/kernel';
import type { IdentityManifest, MigrationRecord, IdentityTables } from './domain.ts';

export interface IdentityReadFace {
  manifest(): IdentityManifest;
  migrations(): readonly MigrationRecord[];
  activeProfile(): string;
}

export function identityInvariantChecks(domain: TdaDomain<IdentityTables>, face?: IdentityReadFace): TdaInvariantCheck[] {
  void domain;
  const checks: TdaInvariantCheck[] = [];

  checks.push({
    name: 'identity-verified-only-active',
    run(fail) {
      // 不变量 2：manifest 组件必须经当前 profile rehearsal 判定（profiles 非空且含当前 profile）。
      const manifest = face?.manifest();
      if (manifest === undefined) return;
      const profile = face?.activeProfile() ?? manifest.activeModelProfile;
      for (const component of [...manifest.components.strategies, ...manifest.components.metaPaths]) {
        if (component.profiles.length === 0 || !component.profiles.includes(profile)) {
          fail(`组件 ${component.ref} 的 profiles 不含当前 profile ${profile}（未经当前 profile 判定即进 active）`);
        }
      }
    },
  });

  checks.push({
    name: 'identity-migration-audited',
    run(fail) {
      // 不变量 4：import/migrate 记录必携 humanTokenRef。
      for (const record of face?.migrations() ?? []) {
        if (record.direction !== 'export' && (record.humanTokenRef === undefined || record.humanTokenRef === '')) {
          fail(`迁移 ${String(record.migrationId)}（${record.direction}）缺人类审批 ref（未审迁移）`);
        }
      }
    },
  });

  checks.push({
    name: 'identity-verdict-auditable',
    run(fail) {
      // 不变量 9：verified/degraded 判定必带 rehearsalId（可回溯复算）。
      for (const record of face?.migrations() ?? []) {
        for (const verdict of record.verdicts) {
          if (verdict.verdict !== 'failed' && verdict.rehearsalId === undefined) {
            fail(`迁移 ${String(record.migrationId)} 组件 ${verdict.ref} 判定 ${verdict.verdict} 却无 rehearsalId（判定依据不可复算）`);
          }
        }
      }
    },
  });

  checks.push({
    name: 'identity-manifest-version-chain',
    run(fail) {
      // 不变量 7：manifest 版本链 supersede 完整（v(n) 的 supersedes = v(n-1) 的 manifestId）。
      const manifests = [...domain.table('identity_manifests').entries()].map(([, value]) => value as IdentityManifest);
      const sorted = manifests.slice().sort((a, b) => a.version - b.version);
      for (let index = 1; index < sorted.length; index += 1) {
        const prev = sorted[index - 1]!;
        const curr = sorted[index]!;
        if (curr.supersedes !== prev.manifestId) {
          fail(`manifest v${curr.version} 的 supersedes 不指向 v${prev.version}（版本链断裂）`);
        }
      }
    },
  });

  checks.push({
    name: 'identity-params-singleton',
    run(fail) {
      const rows = [...domain.table('identity_params').keys()];
      if (rows.length !== 1 || rows[0] !== 'singleton') {
        fail(`identity_params 必须恰有一行 singleton（现状 ${rows.length} 行）`);
      }
    },
  });

  return checks;
}

export function registerIdentityInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<IdentityTables>,
  face?: IdentityReadFace,
): () => void {
  return registry.register('tda-identity', tdaPluginInstaller(identityInvariantChecks(domain, face)));
}
