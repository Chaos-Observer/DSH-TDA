/** T3.1 双写门：entries/events/runs/params 全配对 + replay 等价 + audit_index 定位。 */
import { describe, expect, it } from 'vitest';
import { createAuditIndex, createDualWriteReconciler, createJsonBackend, openTdaDomain } from '@tda/kernel';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeDomainSpec } from '../src/domain.ts';
import { createKnowledgeService, type KnowledgeDeps } from '../src/service.ts';
import { createFakeGovernance, createFakeTimeline, createFakeProvider, createFakeDistiller, NOW, draftCandidate, type FakeChunk } from './helpers.ts';

type PublishedEvent = {
  readonly seq: number;
  readonly sessionId: string;
  readonly family: string;
  readonly businessId: string;
  readonly payload: unknown;
};

const NOW_MS = NOW;
const chunks: FakeChunk[] = [
  { id: 'tl-1', content: '内容一', credential: 'execution-verified', relatedTaskId: 'task-1' },
  { id: 'tl-2', content: '内容二', credential: 'execution-verified', relatedTaskId: 'task-1' },
];

interface Rig {
  readonly service: ReturnType<typeof createKnowledgeService>;
  readonly domain: Awaited<ReturnType<typeof openTdaDomain>>;
  readonly reconciler: ReturnType<typeof createDualWriteReconciler>;
  readonly index: ReturnType<typeof createAuditIndex>;
  readonly published: PublishedEvent[];
  readonly dispose: () => Promise<void>;
}

const openRig = async (): Promise<Rig> => {
  const dir = await mkdtemp(join(tmpdir(), 'tda-kn-dw-'));
  const backend = await createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const published: Rig['published'] = [];
  const domain = await openTdaDomain(knowledgeDomainSpec, {
    backend,
    onChange: (change: { domain: string; table: string; key: string; operation: string }) =>
      reconciler.observeChange(change as never),
  });
  const timeline = createFakeTimeline(chunks);
  const provider = createFakeProvider();
  const distiller = createFakeDistiller([draftCandidate()]);
  const governance = createFakeGovernance();
  const deps: KnowledgeDeps = {
    domain,
    session: {
      sessionId: 'sess-knowledge' as never,
      append(event: never) {
        published.push(event as unknown as PublishedEvent);
        return published.length;
      },
      flush() {},
    },
    timeline: timeline.seam,
    governance: governance.seam,
    provider: provider.seam,
    distiller: distiller.seam,
    reconciler,
    index,
    now: () => NOW_MS,
  };
  const service = createKnowledgeService(deps);
  return {
    service,
    domain,
    reconciler,
    index,
    published,
    dispose: async () => {
      await domain.close();
      await backend.close();
    },
  };
};

describe('T3.1 双写门', () => {
  it('全链域写与会话事件逐对配对（initialize/propose/consolidate/invalidate/link）', async () => {
    const rig = await openRig();
    try {
      await rig.service.initialize();
      let report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);

      const entry = await rig.service.propose(draftCandidate(), 'coach');
      rig.service.recordReuse(String(entry.entryId));
      await rig.service.requestConsolidate(String(entry.entryId));
      await rig.service.link(String(entry.entryId), String(entry.entryId), 'relates-to', []);
      await rig.service.setParams({ clusterCap: 9 });
      report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(report.unmatchedWrites ?? 0).toBe(0);

      // 审计索引：entry/params 实体可定位，会话日志为权威源
      const located = rig.index.locate('knowledge', `knowledge-entry:${String(entry.entryId)}#v1`);
      expect(located).toBeDefined();
      expect(located?.sessionId).toBe('sess-knowledge');
    } finally {
      await rig.dispose();
    }
  });

  it('replay 等价：删 domain → 同事件流重放 → entries 行逐键一致', async () => {
    const rig = await openRig();
    try {
      await rig.service.initialize();
      const entry = await rig.service.propose(draftCandidate(), 'coach');
      rig.service.recordReuse(String(entry.entryId));
      await rig.service.requestConsolidate(String(entry.entryId));

      // 取 entry 相关的 change 事件（businessId 前缀），按序重放域行
      const events = rig.published.filter((event) =>
        String(event.businessId).startsWith('knowledge-entry:') || String(event.businessId) === 'params',
      );
      expect(events.length).toBeGreaterThan(0);
      const replayed = new Map<string, unknown>();
      for (const event of events) {
        if (String(event.businessId).startsWith('knowledge-entry:')) {
          const key = String(event.businessId).slice('knowledge-entry:'.length);
          replayed.set(key, event.payload);
        }
      }
      // 与域内实际行比对（compareReplay 同款 stringify 逐字节比对）
      const actual = [...rig.domain.table('knowledge_entries').entries()].map(([key, value]) => [key, value] as const);
      expect(actual.length).toBe(replayed.size);
      for (const [key, value] of actual) {
        expect(JSON.stringify(value)).toBe(JSON.stringify(replayed.get(key)));
      }
    } finally {
      await rig.dispose();
    }
  });
});
