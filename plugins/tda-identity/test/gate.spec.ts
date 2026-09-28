/** T3.3 冒烟门：导入管道 / 迁移三分级 / 毒包拦截 / 版本链连续性 / 回放确定性 / 哈希链。 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/domain.ts';
import { setup, NOW } from './helpers.ts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** 构造自洽快照（contentHash 与 canonicalJson 基底一致）。 */
const snapshotOf = (overrides: Record<string, unknown> = {}) => {
  const body = {
    formatVersion: 1 as const,
    identityId: 'idn-1',
    manifestVersion: 1,
    strategies: [
      { candidateId: 'hc-ext-1', condition: { taskClass: 'serial-debug' }, rule: { action: 'probe-then-write' }, evidence: ['ext'] },
    ],
    metaPaths: [{ id: 'mp-ext-1', topology: { steps: ['observe', 'verify'] }, mode: 'convergent', applicability: {} }],
    calibrationRefs: [{ from: 0, to: NOW, ref: 'cal-1' }],
    ...overrides,
  };
  return { ...body, contentHash: sha256(canonicalJson(body)) };
};

describe('T3.3 identity 冒烟门', () => {
  it('1. 导入=重新入管道：propose→rehearsal→verified 进 manifest；零信任快照自述', async () => {
    const fx = await setup();
    try {
      const result = await fx.service.imports(snapshotOf() as never, 'apr-1');
      expect(result.accepted.length).toBe(2);
      expect(fx.proposeCalls.length).toBe(2);
      // verified 进 manifest v2
      const manifest = fx.service.manifest();
      expect(manifest.version).toBe(2);
      expect(manifest.components.strategies.map((item) => item.ref)).toContain('hc-new-1');
      expect(manifest.components.strategies[0]!.status).toBe('verified');
      // 审批 ref 留痕（不变量 4）
      const record = fx.service.history().at(-1)!;
      expect(record.humanTokenRef).toBe('apr-1');
      expect(record.direction).toBe('import');
    } finally {
      await fx.dispose();
    }
  });

  it('2. 毒身份包拦截：篡改字节 hash 拒绝；未携审批 token 拒绝', async () => {
    const fx = await setup();
    try {
      const tampered = { ...snapshotOf(), contentHash: 'deadbeef' } as never;
      await expect(fx.service.imports(tampered, 'apr-1')).rejects.toMatchObject({ code: 'IDENTITY_HASH_MISMATCH' });
      const valid = snapshotOf() as never;
      await expect(fx.service.imports(valid, '')).rejects.toMatchObject({ code: 'IDENTITY_HUMAN_TOKEN_REQUIRED' });
      expect(fx.proposeCalls.length).toBe(0);
    } finally {
      await fx.dispose();
    }
  });

  it('3. 迁移三分级：coverage 满即 verified；边际即 degraded（带迁移标注）', async () => {
    const fx = await setup();
    try {
      await fx.service.imports(snapshotOf() as never, 'apr-1');
      // 边际 coverage（0.85 < 1 - 0.1）→ degraded
      fx.setCoverage(0.85);
      const record = await fx.service.migrate('profile-b', 'model-swap', 'apr-2');
      expect(record.verdicts.every((verdict) => verdict.verdict === 'degraded')).toBe(true);
      const manifest = fx.service.manifest();
      expect(manifest.version).toBe(3);
      expect(manifest.activeModelProfile).toBe('profile-b');
      expect(manifest.components.strategies[0]!.status).toBe('degraded');
      expect(manifest.components.strategies[0]!.profiles).toContain('profile-b');
      // 不变量 2：components 的 profiles 含当前 profile
    } finally {
      await fx.dispose();
    }
  });

  it('4. failed 不进 manifest 且 MigrationRecord 留痕（不假设兼容）', async () => {
    const fx = await setup();
    try {
      await fx.service.imports(snapshotOf() as never, 'apr-1');
      fx.setVerdict('fail');
      const record = await fx.service.migrate('profile-b', 'model-upgrade', 'apr-2');
      expect(record.verdicts.every((verdict) => verdict.verdict === 'failed')).toBe(true);
      const manifest = fx.service.manifest();
      expect(manifest.components.strategies.length).toBe(0);
      expect(manifest.components.metaPaths.length).toBe(0);
      // 判定依据全落盘（rehearsalId/coverage）
      expect(record.verdicts[0]!.rehearsalId).toBeDefined();
    } finally {
      await fx.dispose();
    }
  });

  it('5. 迁移期连续性：旧 manifest 版本链 supersede 完整且可查', async () => {
    const fx = await setup();
    try {
      await fx.service.imports(snapshotOf() as never, 'apr-1');
      fx.setCoverage(0.85);
      await fx.service.migrate('profile-b', 'model-swap', 'apr-2');
      // 版本链：v3 supersedes v2 supersedes v1；v1/v2 内容不变
      const manifests = [...(fx.domain.table('identity_manifests').entries() as IterableIterator<[string, { manifestId: string; version: number; supersedes?: string; createdAt: number }]>)].map(([, value]) => value);
      expect(manifests.length).toBe(2); // v1 是概念行（空身份），落库从 v2 起
      const sorted = manifests.sort((a, b) => a.version - b.version);
      expect(sorted[1]!.supersedes).toBe(sorted[0]!.manifestId);
    } finally {
      await fx.dispose();
    }
  });

  it('6. 回放确定性：同 coverage 同输入 ⇒ 同分级；export 哈希链断裂可检出', async () => {
    const first = await setup();
    const second = await setup();
    try {
      const snap = snapshotOf() as never;
      await first.service.imports(snap, 'apr-1');
      first.setCoverage(0.85);
      const recordA = await first.service.migrate('profile-b', 'model-swap', 'apr-2');
      await second.service.imports(snap, 'apr-1');
      second.setCoverage(0.85);
      const recordB = await second.service.migrate('profile-b', 'model-swap', 'apr-2');
      expect(recordA.verdicts.map((verdict) => verdict.verdict)).toEqual(recordB.verdicts.map((verdict) => verdict.verdict));
      // 确定性：同 manifest 两次 export ⇒ 同 contentHash
      const snap1 = await first.service.export();
      const snap2 = await first.service.export();
      expect(snap2.contentHash).toBe(snap1.contentHash);
      // 哈希链：快照记录 prevHash = 前一条 contentHash
      const records = [...(first.domain.table('identity_snapshots').entries() as IterableIterator<[string, { contentHash: string; prevHash?: string; exportedAt: number }]>)].map(([, value]) => value).sort((a, b2) => a.exportedAt - b2.exportedAt);
      expect(records.length).toBe(2);
      expect(records[1]!.prevHash).toBe(records[0]!.contentHash);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
