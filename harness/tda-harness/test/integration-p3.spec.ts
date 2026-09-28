/**
 * P3 集成门：knowledge × supervision × identity × security 真装配语义。
 *
 *  1. 全链：时间线证据 → supervision 审批（token 消费）→ knowledge 蒸馏提议 →
 *     复用 + 出库阀（经治理 assetKind='knowledge'）→ 物化 chunk；identity 导入/迁移
 *     （rehearsal 桥重判定）→ security 红队 run 全 blocked（三面真实探针）
 *  2. 轨迹对账：replayCheck 零违规（P3 三族在 sources 里）+ 实体可定位
 *  3. 持久化：dispose 后同目录重装配，pending 审批项 + 知识条目原样 + 不变量复验
 */
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleRuntime } from '../src/runtime.ts';

function createClock(start = 1_791_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

const cleanupDir = (dir: string): void => {
  // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
};

describe('P3 集成：knowledge × supervision × identity × security 装配后闭环', () => {
  it('1. 全链：审批 token → 知识出库阀 → identity 迁移三分级 → 红队 run 全 blocked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-p3-'));
    const clock = createClock();
    const runtime = await assembleRuntime({ dir, now: clock.now, securityFixtureDir: join(REPO_ROOT, 'fixtures', 'redteam') });
    try {
      const goals = runtime.goalTree.service;
      const tasks = runtime.taskPool.service;
      const timeline = runtime.timeline.service;
      const writer = { sessionId: String(runtime.host.sessionId), actor: 'scheduler' as const, at: clock.now() };

      const goal = await goals.create('human', { objective: '灯环知识沉淀', completionCriteria: ['图谱齐全'] });
      await goals.focus('human', goal.id, { expectedRevision: goal.revision });
      const task = await tasks.create('human', { goalId: goal.id, subject: '整理知识', budget: { tokens: 5_000 } });
      await tasks.claim('human', task.id, { expectedRevision: task.revision }, runtime.host.sessionId);
      for (const content of ['灯环配对方法 A', '灯环配对方法 B', '灯环配对方法 C']) {
        await timeline.append(writer, {
          content,
          chunkType: 'method',
          source: 'task',
          credential: 'execution-verified',
          relatedTaskId: task.id,
        });
      }

      // ① 监督：高风险请求 → 规则表定级 high → 人类 token 消费 → ResumeTicket
      const approval = await runtime.supervision.service.request({
        kind: 'task-proposal',
        requester: { service: 'test', ref: 'req-1' },
        subject: '高风险任务提议',
        whatToShow: {
          summary: '包含不可逆设备写入',
          impact: [{ target: 'device', change: 'execute', reversible: false }],
          riskReasons: ['irreversible'],
          evidence: [],
        },
        resume: { from: 'starting', handle: 'handle-1' },
        taskId: task.id,
        goalId: goal.id,
      });
      expect(approval.riskLevel).toBe('high');
      const ticket = await runtime.supervision.service.approve(String(approval.approvalId), approval.token.nonce);
      expect(ticket.handle).toBe('handle-1');

      // ② 知识：时间线证据 → propose（凭证继承 execution-verified）→ 复用 → 出库阀（治理留痕）
      const sources = runtime.knowledge.service.entries();
      void sources;
      const candidate = {
        kind: 'method' as const,
        title: '灯环配对法',
        summary: '先发配对指令等待 SN 回帧，确认链路后进入控制序列。',
        edges: [],
        evidenceChunkRefs: runtime.knowledge.service.entries === undefined ? [] : [],
      };
      void candidate;
      // 从时间线取真实 chunk id
      const hits = timeline.search({ text: '灯环配对方法', mode: 'fts' });
      expect(hits.length).toBeGreaterThanOrEqual(3);
      const entry = await runtime.knowledge.service.propose(
        {
          kind: 'method',
          title: '灯环配对法',
          summary: '先发配对指令等待 SN 回帧，确认链路后进入控制序列。',
          edges: [],
          evidenceChunkRefs: hits.slice(0, 3).map((hit) => String(hit.entry.id)),
        },
        'human',
      );
      expect(entry.credential).toBe('execution-verified');
      runtime.knowledge.service.recordReuse(String(entry.entryId));
      const consolidated = await runtime.knowledge.service.requestConsolidate(String(entry.entryId));
      expect(consolidated.status).toBe('consolidated');
      expect(consolidated.chunkRef).toBeDefined();
      // 治理单一：lifecycle 经 ctx.governance（assetKind='knowledge'）
      expect(runtime.governance.service.lifecycleOf(String(entry.entryId), 'knowledge')).toBe('consolidated');
      // 出库阀：零复用拒绝
      const draft2 = await runtime.knowledge.service.propose(
        {
          kind: 'concept',
          title: '零复用概念',
          summary: '尚无复用证据。',
          edges: [],
          evidenceChunkRefs: [String(hits[0]!.entry.id)],
        },
        'human',
      );
      await expect(runtime.knowledge.service.requestConsolidate(String(draft2.entryId))).rejects.toMatchObject({
        code: 'KNOWLEDGE_OUT_VALVE',
      });

      // ③ 身份：导出 → 导入（rehearsal 桥重判定 → verified）→ manifest v2
      const snapshot = await runtime.identity.service.export();
      void snapshot;
      const importBody = {
        formatVersion: 1 as const,
        identityId: 'idn-1',
        manifestVersion: 1,
        strategies: [{ candidateId: 'hc-ext-1', condition: { k: 'v' }, rule: { a: 'b' }, evidence: ['x'] }],
        metaPaths: [],
        calibrationRefs: [],
      };
      // 用真实 hash（测试内重算：canonicalJson 由 identity 出口提供）
      const { canonicalJson } = await import('tda-identity');
      const { createHash } = await import('node:crypto');
      const contentHash = createHash('sha256').update(canonicalJson(importBody)).digest('hex');
      const result = await runtime.identity.service.imports({ ...importBody, contentHash }, 'apr-human-1');
      expect(result.accepted.length).toBe(1);
      expect(runtime.identity.service.manifest().version).toBe(2);
      const migration = await runtime.identity.service.migrate('profile-b', 'model-swap', 'apr-human-2');
      expect(migration.verdicts[0]!.verdict).toBe('verified');

      // ④ 红队：run 全 blocked（记忆注入真探针走时间线+recall gate；token 重放/毒身份走真防线）
      const redteam = await runtime.security.service.run('injection-redteam');
      expect(redteam.status).toBe('reported');
      expect(redteam.results.every((result) => result.actual === 'blocked')).toBe(true);
      expect(runtime.security.service.gateBlocked()).toBe(false);
      const penetration = await runtime.security.service.run('penetration');
      expect(penetration.results.every((result) => result.actual === 'blocked')).toBe(true);

      // ⑤ driveP3 冒烟
      const drive = await runtime.driveP3();
      expect(drive.securityCases).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
      cleanupDir(dir);
    }
  });

  it('2. 轨迹对账：replayCheck 零违规（P3 三族已进 sources）+ 实体可定位', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-p3-rc-'));
    const clock = createClock();
    const runtime = await assembleRuntime({ dir, now: clock.now, securityFixtureDir: join(REPO_ROOT, 'fixtures', 'redteam') });
    try {
      const approval = await runtime.supervision.service.request({
        kind: 'dispatch',
        requester: { service: 'test', ref: 'r' },
        subject: '对账探针',
        whatToShow: {
          summary: 's',
          impact: [{ target: 'x', change: 'update', reversible: true }],
          riskReasons: [],
          evidence: [],
        },
        resume: { from: 'starting', handle: 'h' },
        taskId: 'task-probe',
        goalId: 'goal-probe',
      });
      void approval;
      const report = await runtime.trajectory.service.replayCheck();
      expect(report.ok).toBe(true);
      // P3 实体可定位
      const located = runtime.trajectory.service.auditView({ entityKind: 'approval', entityId: 'approval:apr-1' });
      expect(located.length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
      cleanupDir(dir);
    }
  });

  it('3. 持久化：dispose 后重装配，pending 审批项 + 知识条目原样 + 不变量复验', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-p3-persist-'));
    const clock = createClock();
    {
      const first = await assembleRuntime({ dir, now: clock.now, securityFixtureDir: join(REPO_ROOT, 'fixtures', 'redteam') });
      await first.supervision.service.request({
        kind: 'governance',
        requester: { service: 'test', ref: 'r' },
        subject: '持久化探针',
        whatToShow: {
          summary: 's',
          impact: [{ target: 'x', change: 'update', reversible: true }],
          riskReasons: [],
          evidence: [],
        },
        resume: { from: 's', handle: 'h' },
        taskId: 'task-1',
      });
      const timeline = first.timeline.service;
      const writer = { sessionId: String(first.host.sessionId), actor: 'scheduler' as const, at: clock.now() };
      const chunk = await timeline.append(writer, {
        content: '持久化证据 chunk',
        chunkType: 'fact',
        source: 'task',
        credential: 'execution-verified',
      });
      await first.knowledge.service.propose(
        { kind: 'concept' as const, title: '持久化条目', summary: '跨重启验证。', edges: [], evidenceChunkRefs: [String(chunk.id)] },
        'human',
      );
      await first.dispose();
    }
    {
      const second = await assembleRuntime({ dir, now: clock.now, securityFixtureDir: join(REPO_ROOT, 'fixtures', 'redteam') });
      try {
        expect(second.supervision.service.pending().length).toBe(1);
        const entries = second.knowledge.service.entries();
        expect(entries.length).toBe(1);
        expect(entries[0]!.title).toBe('持久化条目');
        await second.verifyInvariants();
      } finally {
        await second.dispose();
        cleanupDir(dir);
      }
    }
  });
});
