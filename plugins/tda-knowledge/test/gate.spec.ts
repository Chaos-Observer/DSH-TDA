/** T3.1 冒烟门：Wiki 蒸馏闭环 / 分层互链 / 矛盾失效+回滚 / 凭证继承 / 外置降级 / 双帽。 */
import { describe, expect, it } from 'vitest';
import { knowledgeDomainSpec } from '../src/domain.ts';
import { createKnowledgeService } from '../src/service.ts';
import { createFakeGovernance, createFakeTimeline, NOW, draftCandidate, setup, type FakeChunk, type SetupOptions } from './helpers.ts';

const chunks: FakeChunk[] = [
  { id: 'tl-1', content: '灯环配对：先发 $01*01，等 SN 回帧', credential: 'execution-verified', relatedTaskId: 'task-1', trajectoryRef: 'traj-a' },
  { id: 'tl-2', content: '灯环配对：SN 帧格式 $SN,<hex>*XX', credential: 'execution-verified', relatedTaskId: 'task-1', trajectoryRef: 'traj-b' },
  { id: 'tl-3', content: '灯环控制：亮度指令 $L,<n>*XX', credential: 'execution-verified', relatedTaskId: 'task-1' },
];

const options = (overrides: SetupOptions = {}): SetupOptions => ({ chunks, ...overrides });

describe('T3.1 knowledge 冒烟门', () => {
  it('1. Wiki 蒸馏闭环：同任务簇→distill→draft→复用+验证→consolidated→物化 chunk+入图；零复用拒绝', async () => {
    const fx = await setup({
      ...options(),
      candidates: [
        draftCandidate({ title: '灯环配对法', summary: '先发配对指令等待 SN 回帧，确认链路后进入控制序列。' }),
        draftCandidate({ title: '零复用法', summary: '尚无复用证据的条目。' }),
      ],
    });
    try {
      const run = await fx.service.distill({ kind: 'manual' });
      expect(run.status).toBe('recorded');
      expect(run.clusterCount).toBeGreaterThanOrEqual(1);
      expect(run.candidatesProposed.length).toBe(2);
      const draft = fx.service.entries({ status: 'draft' });
      expect(draft.length).toBe(2);

      // 零复用条目直接固化 → 出库阀拒绝（§3.6 出库需复用/审查）
      const zeroReuse = fx.service.entry(String(draft.find((entry) => entry.title === '零复用法')!.entryId));
      await expect(fx.service.requestConsolidate(String(zeroReuse.entryId))).rejects.toMatchObject({
        code: 'KNOWLEDGE_OUT_VALVE',
      });
      expect(fx.governance.actions.length).toBe(0);

      // 主条目：真实复用（recall 注入 + 任务 success 由调用方记录）+ 验证 → 过阀
      const main = fx.service.entry(String(draft.find((entry) => entry.title === '灯环配对法')!.entryId));
      fx.service.recordReuse(String(main.entryId));
      const consolidated = await fx.service.requestConsolidate(String(main.entryId));
      expect(consolidated.status).toBe('consolidated');
      expect(consolidated.chunkRef).toBeDefined();
      expect(consolidated.graphRef).toBeDefined();
      // 内容权威在时间线：物化 chunk 可经 timeline.get 召回（J8 零改造）
      expect(fx.timeline.store.get(consolidated.chunkRef!)).toBeDefined();
      // 治理留痕（J5）
      expect(fx.governance.actions.some((action) => action.assetKind === 'knowledge')).toBe(true);
    } finally {
      await fx.dispose();
    }
  });

  it('2. 人类审查 token 路：零复用但携 token → 过阀', async () => {
    const fx = await setup({ ...options(), candidates: [draftCandidate()] });
    try {
      const draft = await fx.service.propose(draftCandidate(), 'human');
      const consolidated = await fx.service.requestConsolidate(String(draft.entryId), { humanToken: 'human-hc-1' });
      expect(consolidated.status).toBe('consolidated');
    } finally {
      await fx.dispose();
    }
  });

  it('3. 凭证继承：min(证据 chunk 凭证)；证据全缺 propose 拒绝', async () => {
    const poisoned: FakeChunk[] = [
      { id: 'tl-p1', content: '毒内容一', credential: 'tool-output', relatedTaskId: 'task-2' },
      { id: 'tl-p2', content: '毒内容二', credential: 'execution-verified', relatedTaskId: 'task-2' },
    ];
    const fx = await setup({ chunks: poisoned });
    try {
      const entry = await fx.service.propose(draftCandidate({ evidenceChunkRefs: ['tl-p1', 'tl-p2'] }), 'coach');
      expect(entry.credential).toBe('tool-output');
      await expect(fx.service.propose(draftCandidate({ evidenceChunkRefs: ['tl-404'] }), 'coach')).rejects.toMatchObject({
        code: 'KNOWLEDGE_EVIDENCE_MISSING',
      });
    } finally {
      await fx.dispose();
    }
  });

  it('4. 矛盾失效+回滚：invalidate 置 validTo+双记；reassert append 新版本 supersedes 链', async () => {
    const fx = await setup({ ...options(), candidates: [draftCandidate()] });
    try {
      const draft = await fx.service.propose(draftCandidate(), 'coach');
      fx.service.recordReuse(String(draft.entryId));
      const old = await fx.service.requestConsolidate(String(draft.entryId));
      // 矛盾新条目（contradicts 边）
      const newer = await fx.service.propose(draftCandidate({ title: '配对法 v2', summary: '新方法取代旧方法。' }), 'human');
      await fx.service.link(String(newer.entryId), String(old.entryId), 'contradicts', []);
      const invalidated = await fx.service.invalidate(String(old.entryId), '被 v2 取代');
      expect(invalidated.validity.validTo).toBeDefined();
      expect(invalidated.status).toBe('invalidated');
      // 双记：时间线 invalidate + Graphiti invalidate
      expect(fx.timeline.invalidated.length).toBe(1);
      expect(fx.provider.invalidated).toContain(String(old.entryId));
      // 回滚 = re-assert（append 新版本，不改历史）
      const reasserted = await fx.service.reassert(String(old.entryId), 'human');
      expect(reasserted.supersedes).toBe(String(old.entryId));
      expect(reasserted.status).toBe('draft');
      expect(fx.service.history(String(reasserted.entryId)).length).toBe(2);
    } finally {
      await fx.dispose();
    }
  });

  it('5. 分层互链双帽：fanInCap 拒绝第 3 个 MOC 父；depthCap 拒绝超深层级', async () => {
    const fx = await setup({ chunks: [] });
    try {
      const moc1 = await fx.service.propose(draftCandidate({ kind: 'moc', title: 'MOC 硬件调试', evidenceChunkRefs: [] }), 'human');
      const moc2 = await fx.service.propose(draftCandidate({ kind: 'moc', title: 'MOC 串口', evidenceChunkRefs: [] }), 'human');
      const moc3 = await fx.service.propose(draftCandidate({ kind: 'moc', title: 'MOC 外设', evidenceChunkRefs: [] }), 'human');
      const leaf = await fx.service.propose(draftCandidate({ title: 'CH343 使用', evidenceChunkRefs: [] }), 'human');
      await fx.service.link(String(leaf.entryId), String(moc1.entryId), 'part-of', []);
      await fx.service.link(String(leaf.entryId), String(moc2.entryId), 'part-of', []);
      await expect(fx.service.link(String(leaf.entryId), String(moc3.entryId), 'part-of', [])).rejects.toMatchObject({
        code: 'KNOWLEDGE_FANIN_CAP',
      });
      // depthCap=3：mocB→mocA、mocC→mocB 成两跳；leaf2 挂 mocC=第 3 层 OK，其下再挂=第 4 层拒绝
      const mocA = moc1;
      const mocB = moc2;
      await fx.service.link(String(mocB.entryId), String(mocA.entryId), 'part-of', []);
      await fx.service.link(String(moc3.entryId), String(mocB.entryId), 'part-of', []);
      const leaf2 = await fx.service.propose(draftCandidate({ kind: 'moc', title: 'MOC 三层叶', evidenceChunkRefs: [] }), 'human');
      await fx.service.link(String(leaf2.entryId), String(moc3.entryId), 'part-of', []);
      const deep = await fx.service.propose(draftCandidate({ kind: 'moc', title: 'MOC 更深', evidenceChunkRefs: [] }), 'human');
      await expect(fx.service.link(String(deep.entryId), String(leaf2.entryId), 'part-of', [])).rejects.toMatchObject({
        code: 'KNOWLEDGE_DEPTH_CAP',
      });
    } finally {
      await fx.dispose();
    }
  });

  it('6. 外置降级：Graphiti 断连 → consolidated 主链路不阻断（chunk 在 graphRef 空）+ 恢复重放', async () => {
    const fx = await setup({ ...options({ providerAvailable: false }), candidates: [draftCandidate()] });
    try {
      const draft = await fx.service.propose(draftCandidate(), 'coach');
      fx.service.recordReuse(String(draft.entryId));
      const consolidated = await fx.service.requestConsolidate(String(draft.entryId));
      expect(consolidated.chunkRef).toBeDefined();
      expect(consolidated.graphRef).toBeUndefined();
      // 邻接降级（事件图投影）不抛
      expect(fx.service.neighbors(String(consolidated.entryId), 1).entries).toEqual([]);
      // 恢复：flushQueued 重放队列（本例队列空 = ingest 走事件重摄入）
      fx.provider.setAvailable(true);
      expect(await fx.service.flushQueued()).toBe(0);
    } finally {
      await fx.dispose();
    }
  });

  it('7. 图扩展候选源：expand 返回证据条目（供 recall 同池竞争）', async () => {
    const fx = await setup({ ...options(), candidates: [draftCandidate()] });
    try {
      const draft = await fx.service.propose(draftCandidate(), 'coach');
      fx.service.recordReuse(String(draft.entryId));
      const consolidated = await fx.service.requestConsolidate(String(draft.entryId));
      const expanded = fx.service.expand(['tl-1']);
      expect(expanded.some((item) => item.entryId === String(consolidated.entryId))).toBe(true);
    } finally {
      await fx.dispose();
    }
  });

  it('8. distill 失败进显式终态：distiller 缺席 → failed(cluster)+reason', async () => {
    const dir = await (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'tda-kn-fail-'));
    const backend = await (await import('@tda/kernel')).createJsonBackend(dir);
    const domain = await (await import('@tda/kernel')).openTdaDomain(knowledgeDomainSpec, { backend });
    const timeline = createFakeTimeline(chunks);
    const service = createKnowledgeService({
      domain,
      session: { sessionId: 'sess-knowledge' as never, append: () => 1, flush() {} },
      timeline: timeline.seam,
      governance: createFakeGovernance().seam,
      now: () => NOW,
    });
    await service.initialize();
    const run = await service.distill({ kind: 'manual' });
    expect(run.status).toBe('failed');
    expect(run.stage).toBe('cluster');
    expect(run.failureReason).toContain('seam');
    await domain.close();
    await backend.close();
  });
});
