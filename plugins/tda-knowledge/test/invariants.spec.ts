/** T3.1 不变量门：五条检查各自红 + 注册表登记对账。 */
import { describe, expect, it } from 'vitest';
import { createTdaInvariantRegistry, openTdaDomain, createJsonBackend, tdaPluginInstaller } from '@tda/kernel';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeDomainSpec, type KnowledgeEntry } from '../src/domain.ts';
import { knowledgeInvariantChecks, registerKnowledgeInvariants, type KnowledgeReadFace } from '../src/loadChecks.ts';
import { createKnowledgeService } from '../src/service.ts';
import { createFakeGovernance, createFakeTimeline, NOW, draftCandidate, type FakeChunk } from './helpers.ts';

const NOW_MS = NOW;
const chunks: FakeChunk[] = [
  { id: 'tl-1', content: '内容一', credential: 'execution-verified', relatedTaskId: 'task-1' },
  { id: 'tl-2', content: '内容二', credential: 'execution-verified', relatedTaskId: 'task-1' },
];

const openRig = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tda-kn-inv-'));
  const backend = await createJsonBackend(dir);
  const domain = await openTdaDomain(knowledgeDomainSpec, { backend });
  return {
    domain,
    backend,
    dispose: async () => {
      await domain.close();
      await backend.close();
    },
  };
};

import type { KnowledgeEdge, KnowledgeRun } from '../src/domain.ts';
const faceOf = (entries: KnowledgeEntry[], runs: readonly KnowledgeRun[] = [], edges: readonly KnowledgeEdge[] = []): KnowledgeReadFace => ({
  entries: () => entries,
  runs: () => runs,
  params: () => ({
    distillThresholds: { reuse: 2, verify: 1, associationSpread: 2 },
    clusterCap: 8,
    depthCap: 3,
    fanInCap: 2,
    periodMs: 1,
    distillConcurrency: 1,
    invalidateQueueCap: 64,
    revision: 0,
  }),
  edges: () => edges,
});

const entryOf = (overrides: Partial<KnowledgeEntry> & { entryId: string }): KnowledgeEntry => {
  const { entryId, ...rest } = overrides;
  return {
    entryId: entryId as never,
    version: 1,
    kind: 'method',
    title: '标题',
    summary: '摘要。',
    status: 'draft',
    credential: 'execution-verified',
    validity: { validFrom: NOW_MS, ingestedAt: NOW_MS },
    evidence: { chunkRefs: ['tl-1'], trajectoryRefs: [] },
    stats: { reuseCount: 0, verifyCount: 0, associationSpread: 0 },
    createdBy: 'distill',
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
    ...rest,
  } as KnowledgeEntry;
};

describe('T3.1 不变量门', () => {
  it('knowledge-entries-graphref-gate：draft 带 graphRef 即红', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      const face = faceOf([entryOf({ entryId: 'kn-1' as never, graphRef: 'graph:x' })]);
      registerKnowledgeInvariants(registry, rig.domain, face);
      await expect(registry.verify('tda-knowledge')).rejects.toThrowError(/未验证零入图/);
    } finally {
      await rig.dispose();
    }
  });

  it('knowledge-entries-evidence-present：非人工条目零证据即红', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      const face = faceOf([entryOf({ entryId: 'kn-1' as never, evidence: { chunkRefs: [], trajectoryRefs: [] } })]);
      registerKnowledgeInvariants(registry, rig.domain, face);
      await expect(registry.verify('tda-knowledge')).rejects.toThrowError(/无证据 chunk 引用/);
    } finally {
      await rig.dispose();
    }
  });

  it('knowledge-runs-wellformed：failed 缺 stage/reason 即红', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      const face = faceOf(
        [],
        [
          {
            runId: 'kr-1' as never,
            trigger: { kind: 'manual' as const },
            status: 'failed' as const,
            clusterCount: 0,
            candidatesProposed: [],
            skipped: [],
            reportChunkIds: [],
            startedAt: NOW_MS,
          },
        ],
      );
      registerKnowledgeInvariants(registry, rig.domain, face);
      await expect(registry.verify('tda-knowledge')).rejects.toThrowError(/显式终态/);
    } finally {
      await rig.dispose();
    }
  });

  it('knowledge-params-singleton：缺行即红（initialize 未跑）', async () => {
    const rig = await openRig();
    try {
      const registry = createTdaInvariantRegistry();
      registerKnowledgeInvariants(registry, rig.domain, faceOf([]));
      await expect(registry.verify('tda-knowledge')).rejects.toThrowError(/singleton/);
    } finally {
      await rig.dispose();
    }
  });

  it('knowledge-edge-fanin-cap：投影对账出 3 父即红', async () => {
    const rig = await openRig();
    try {
      // 先播种 params 行（否则首个失败是 singleton，聚合错误消息对不上 fanInCap）
      await rig.domain.table('knowledge_params').put('singleton', {
        distillThresholds: { reuse: 2, verify: 1, associationSpread: 2 },
        clusterCap: 8, depthCap: 3, fanInCap: 2, periodMs: 1, distillConcurrency: 1, invalidateQueueCap: 64, revision: 0,
      });
      const registry = createTdaInvariantRegistry();
      const edges = [
        { edgeId: 'e1', fromId: 'leaf', toId: 'm1', kind: 'part-of' as const, evidence: [] },
        { edgeId: 'e2', fromId: 'leaf', toId: 'm2', kind: 'part-of' as const, evidence: [] },
        { edgeId: 'e3', fromId: 'leaf', toId: 'm3', kind: 'part-of' as const, evidence: [] },
      ];
      registerKnowledgeInvariants(registry, rig.domain, faceOf([], [], edges));
      await expect(registry.verify('tda-knowledge')).rejects.toThrowError(/fanInCap/);
    } finally {
      await rig.dispose();
    }
  });

  it('绿路：真实服务初始化 + 正常条目 → verify 通过；检查清单与规格一一对应', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-kn-inv-ok-'));
    const backend = await createJsonBackend(dir);
    const domain = await openTdaDomain(knowledgeDomainSpec, { backend });
    const timeline = createFakeTimeline(chunks);
    const governance = createFakeGovernance();
    const service = createKnowledgeService({
      domain,
      session: { sessionId: 'sess-knowledge' as never, append: () => 1, flush() {} },
      timeline: timeline.seam,
      governance: governance.seam,
      now: () => NOW_MS,
    });
    await service.initialize();
    await service.propose(draftCandidate(), 'human');
    const registry = createTdaInvariantRegistry();
    const face: KnowledgeReadFace = {
      entries: () => service.entries(),
      runs: () => service.runs(),
      params: () => service.params(),
      edges: () => service.edges(),
    };
    const checks = knowledgeInvariantChecks(domain, face);
    expect(checks.map((check) => check.name).sort()).toEqual([
      'knowledge-edge-fanin-cap',
      'knowledge-entries-evidence-present',
      'knowledge-entries-graphref-gate',
      'knowledge-params-singleton',
      'knowledge-runs-wellformed',
    ]);
    registerKnowledgeInvariants(registry, domain, face);
    await expect(registry.verify('tda-knowledge')).resolves.toBeUndefined();
    await domain.close();
    await backend.close();
    void tdaPluginInstaller;
  });
});
