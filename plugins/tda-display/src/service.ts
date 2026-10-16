/**
 * T4.4 · tda-display 服务实现（J1 纯投影 / J2 内嵌只读 HTTP / J4 零交互写 / J7 报告 / J8 安全 / J9 fail-open）。
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { TdaError } from '@tda/kernel';
import {
  AUDIT_TAIL,
  DISPLAY_DEFAULT_PORT,
  DISPLAY_VERSION,
  OBJECTIVE_MAX_CHARS,
  type ApprovalDigestItem,
  type AuditDigestItem,
  type DisplayDeps,
  type DisplayScope,
  type GoalSummary,
  type StatusDisplayService,
  type StatusReport,
  type StatusSnapshot,
  type TaskCounts,
} from './domain.ts';

// ── 消毒（J8/不变量 5：所有经 markdown 渲染的文本必过 escape） ──

/** HTML/markdown 转义（`<script>` 注入 neutralize；同 T0.5 诊断消毒的展示面对偶）。 */
export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

/** loopback host 白名单（不变量 2：禁 0.0.0.0/公网 IP，fail-loud）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** 单页应用（J5 内联 HTML/JS，零构建零 CDN；**页面静态零动态数据**——数据全走
 *  /api/snapshot + DOM textContent 构建，注入面在浏览器侧天然关闭）。 */
const PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>TDA 状态台</title>
<style>
 body{font-family:system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1c1e21}
 nav{display:flex;gap:4px;padding:10px 16px;background:#fff;border-bottom:1px solid #ddd}
 nav button{border:1px solid #ccc;background:#fff;padding:6px 14px;border-radius:6px;cursor:pointer}
 nav button.active{background:#1c64f2;color:#fff;border-color:#1c64f2}
 main{padding:16px;max-width:1100px;margin:0 auto}
 table{border-collapse:collapse;width:100%;background:#fff}
 td,th{border:1px solid #e2e4e8;padding:6px 10px;text-align:left;font-size:13px}
 .badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:#e8ebf0;margin-right:4px}
 .alt{color:#8a6d3b;font-size:12px}
 .meta{color:#667;font-size:12px;margin:6px 0}
 ul.tree{list-style:none;padding-left:0}
 ul.tree ul{list-style:none;padding-left:22px;border-left:1px dashed #c9cdd4}
</style></head><body>
<nav>
 <button data-v="spectrum" class="active">树谱</button>
 <button data-v="overview">状态总览</button>
 <button data-v="approvals">审批与审计</button>
 <span class="meta" id="meta"></span>
</nav>
<main id="view"></main>
<script>
'use strict';
const $=document.getElementById('view');
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const badge=(t)=>{const s=el('span',t);s.className='badge';return s;};
let current='spectrum', timer=null;
async function load(){try{const r=await fetch('/api/snapshot');if(!r.ok)return;render(await r.json());}catch(e){/* 拉取失败下轮重试 */}}
function tree(node,depth){const li=el('li');
 li.appendChild(badge(node.kind==='goal'?'目标':'任务'));
 li.appendChild(el('strong',node.label));li.appendChild(badge(node.stagePath?node.stagePath.join('/'):''));
 li.appendChild(badge('区域 '+node.zone));
 if(node.altOf)li.appendChild(el('span',' ⇢ 预案备选 '+node.altOf)).className='alt';
 const kids=node.children||[];if(kids.length){const ul=el('ul');kids.forEach(k=>ul.appendChild(tree(k,depth+1)));li.appendChild(ul);}
 return li;}
function render(s){
 document.getElementById('meta').textContent='at '+new Date(s.at).toLocaleTimeString()+(s.degraded.length?'（降级:'+s.degraded.join(',')+'）':'');
 $.replaceChildren();
 if(current==='spectrum'){
  const h=el('h2','树谱');$.appendChild(h);
  const ul=el('ul');ul.className='tree';
  // 由 goals/tasks/edges 重建层级（T4.3 treeView 投影）
  const goalNodes=s.spectrum.goals||[],taskNodes=s.spectrum.tasks||[],edges=s.spectrum.edges||[];
  const tasksOf=(gid)=>taskNodes.filter(t=>edges.some(e=>e.kind==='parent'&&e.from===gid&&e.to===t.id)||t.rootGoalId===gid);
  const childGoals=(gid)=>goalNodes.filter(g=>edges.some(e=>e.kind==='parent'&&e.from===gid&&e.to===g.id));
  const taskAlt=(tid)=>{const e=edges.find(x=>x.kind==='alternativeOf'&&x.from===tid);return e?e.to:undefined;};
  const goalNode=(g,depth)=>{const li=el('li');
   li.appendChild(badge('目标'));li.appendChild(el('strong',g.label));li.appendChild(badge(g.stagePath?g.stagePath.join('/'):''));li.appendChild(badge('区域 '+g.zone));
   if(g.id===(s.spectrum.focusGoalId||''))li.appendChild(badge('焦点'));
   const ul=el('ul');
   childGoals(g.id).forEach(c=>ul.appendChild(goalNode(c,depth+1)));
   tasksOf(g.id).forEach(t=>{const li2=el('li');li2.appendChild(badge('任务'));li2.appendChild(el('span',t.label));li2.appendChild(badge(t.stagePath?t.stagePath.join('/'):''));li2.appendChild(badge('区域 '+t.zone));
    const alt=taskAlt(t.id);if(alt)li2.appendChild(el('span',' ⇢ 预案备选 '+alt)).className='alt';
    ul.appendChild(li2);});
   if(ul.children.length)li.appendChild(ul);
   return li;};
  const roots=goalNodes.filter(g=>!edges.some(e=>e.kind==='parent'&&e.to===g.id));
  roots.forEach(g=>ul.appendChild(goalNode(g,0)));
  if(s.spectrum.truncated)$.appendChild(el('p','⚠ 容量帽截断视图（T4.3 J7）'));
  $.appendChild(ul);
 }else if(current==='overview'){
  const h=el('h2','状态总览');$.appendChild(h);
  const o=s.overview;
  const t=el('p');t.appendChild(el('strong','任务：'));
  ['ready','executing','awaitingApproval','verifying','blocked','completedToday'].forEach(k=>t.appendChild(badge(k+' '+o.tasks[k])));
  $.appendChild(t);
  if(o.drift)$.appendChild(el('p','漂移：'+o.drift.band+'　趋势：['+o.drift.trend.join(', ')+']'));
  if(o.attention)$.appendChild(el('p','注意力：'+o.attention.consumedUnits+'/'+o.attention.quotaUnits+'（'+o.attention.zone+'），待决 '+o.attention.pendingCount));
  const tab=el('table');const tr=el('tr');['目标','阶段','区域','任务','完成'].forEach(x=>tr.appendChild(el('th',x)));tab.appendChild(tr);
  o.goals.forEach(g=>{const r=el('tr');[g.objective,g.phase+' / '+g.stage,g.zone,String(g.taskCount),String(g.completedCount)].forEach(x=>r.appendChild(el('td',x)));tab.appendChild(r);});
  $.appendChild(tab);
 }else{
  const h=el('h2','审批与审计');$.appendChild(h);
  $.appendChild(el('h3','待你决断（'+s.approvals.length+'）——动作仍走 DSH User Approval，本页只呈现'));
  const tab=el('table');const tr=el('tr');['ID','类型','风险','主题','摘要','理由'].forEach(x=>tr.appendChild(el('th',x)));tab.appendChild(tr);
  s.approvals.forEach(a=>{const r=el('tr');[a.approvalId,a.kind,a.riskLevel,a.subject,a.summary,(a.riskReasons||[]).join('；')].forEach(x=>r.appendChild(el('td',x)));tab.appendChild(r);});
  $.appendChild(tab);
  $.appendChild(el('h3','最近决策链'));
  const ul=el('ul');
  s.audit.recentDecisions.forEach(d=>ul.appendChild(el('li',new Date(d.at).toLocaleTimeString()+'　'+d.kind+(d.approvalId?'　'+d.approvalId:''))));
  $.appendChild(ul);
 }
}
document.querySelectorAll('nav button').forEach(b=>b.addEventListener('click',()=>{
 document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');
 current=b.dataset.v;load();}));
timer=setInterval(load,2000);load();
</script></body></html>`;

// ── 服务实现 ────────────────────────────────────────────────────────────

export function createDisplayService(deps: DisplayDeps): StatusDisplayService {
  const clock = deps.now ?? ((): number => Date.now());
  let server: http.Server | undefined;
  let listening = false;
  let boundUrl: string | undefined;
  let boundPort: number | undefined;

  /** 可选 seam 容错读（J9 fail-open：降级记名，不传播）。 */
  const tryRead = <T>(read: () => T, fallback: T | (() => T)): T => {
    try {
      return read();
    } catch {
      // fallback 支持惰性形式（降级记名在 fallback 体内执行）
      return typeof fallback === 'function' ? (fallback as () => T)() : fallback;
    }
  };

  const snapshot = (scope?: DisplayScope): StatusSnapshot => {
    const at = clock();
    const degraded: string[] = [];

    // 视图①：树谱 = T4.3 treeView 原样透传（J3 零复制）
    let spectrum: Record<string, unknown>;
    try {
      spectrum = deps.graph.treeView(scope?.goalId) as Record<string, unknown>;
    } catch (error) {
      degraded.push('graph');
      spectrum = { goals: [], tasks: [], edges: [], truncated: false, degraded: String(error) };
    }

    // 视图②：目标摘要 + 任务计数
    let goalItems: readonly { goalId: string; objective: string; phase: string; stage: string; zone: string; focus: boolean }[] = [];
    try {
      goalItems = deps.goal.list();
    } catch {
      degraded.push('goal');
    }
    let taskItems: readonly {
      id: string;
      goalId: string;
      phase: string;
      stage: string;
      proposalPending: boolean;
      outcome?: string | undefined;
      updatedAt: number;
    }[] = [];
    try {
      taskItems = deps.taskPool.list();
    } catch {
      degraded.push('taskPool');
    }
    const tasksOf = (goalId: string): readonly (typeof taskItems)[number][] =>
      taskItems.filter((task) => task.goalId === goalId);
    const goals: GoalSummary[] = goalItems.map((goal) => {
      const own = tasksOf(goal.goalId);
      return {
        goalId: goal.goalId,
        objective: truncate(goal.objective, OBJECTIVE_MAX_CHARS),
        phase: goal.phase,
        stage: goal.stage,
        zone: goal.zone,
        focus: goal.focus,
        taskCount: own.length,
        completedCount: own.filter((task) => task.phase === 'complete').length,
      };
    });
    const todayStart = new Date(at);
    todayStart.setHours(0, 0, 0, 0);
    const counts: TaskCounts = {
      ready: taskItems.filter((task) => task.phase === 'active' && task.stage === 'planning' && !task.proposalPending).length,
      executing: taskItems.filter((task) => task.phase === 'executing').length,
      awaitingApproval: taskItems.filter((task) => task.proposalPending).length,
      verifying: taskItems.filter((task) => task.phase === 'active' && task.stage === 'verifying').length,
      blocked: taskItems.filter((task) => task.phase === 'blocked').length,
      completedToday: taskItems.filter((task) => task.phase === 'complete' && task.updatedAt >= todayStart.getTime()).length,
    };

    // 视图③：审批摘要（J8：**剥除 whatToShow.excerpts——原文片段不经 HTTP**）与决策链
    const approvals: ApprovalDigestItem[] = tryRead(
    () =>
        (deps.supervision?.pending() ?? []).map((request) => ({
          approvalId: String(request.approvalId),
          kind: request.kind,
          riskLevel: request.riskLevel,
          subject: truncate(request.subject, OBJECTIVE_MAX_CHARS),
          summary: request.whatToShow.summary,
          riskReasons: [...(request.whatToShow.riskReasons ?? [])],
        })),
      () => {
        // 降级 fallback：supervision 未装配视为空而非故障；装配了但读炸 ⇒ 记名
        if (deps.supervision === undefined) return [];
        degraded.push('supervision');
        return [];
      },
    );
    const recentDecisions: AuditDigestItem[] = tryRead(
    () =>
        (deps.supervision?.events() ?? [])
          .filter((event) => event.kind === 'approved' || event.kind === 'rejected' || event.kind === 'cancelled')
          .slice(-AUDIT_TAIL)
          .map((event) => ({
            at: event.at,
            kind: event.kind,
            ...(event.approvalId !== undefined ? { approvalId: event.approvalId } : {}),
          })),
      [],
    );

    // drift/attention：可选降级
    const drift = deps.drift !== undefined
      ? tryRead(
          () => deps.drift?.trend(scope?.goalId),
          () => {
            degraded.push('drift');
            return undefined;
          },
        )
      : undefined;
    const attention = tryRead(
    () => {
        const status = deps.supervision?.attentionStatus();
        return status === undefined
          ? undefined
          : {
              consumedUnits: status.consumedUnits,
              quotaUnits: status.quotaUnits,
              zone: status.zone,
              pendingCount: status.pendingCount,
            };
      },
      () => {
        // pending 正常返回空 ≠ 降级；attentionStatus 炸才记名（J9 fail-open）
        if (deps.supervision !== undefined) degraded.push('supervision');
        return undefined;
      },
    );

    const focusGoal = goals.find((goal) => goal.focus);

    return {
      at,
      spectrum,
      overview: {
        ...(focusGoal !== undefined ? { focusGoal } : {}),
        goals,
        tasks: counts,
        ...(drift !== undefined ? { drift: { band: drift.band, trend: [...drift.trend] } } : {}),
        ...(attention !== undefined ? { attention } : {}),
      },
      approvals,
      audit: { recentDecisions },
      degraded,
    };
  };

  /** J7：markdown 人读报告（全部字段过 escape；落时间线 credential 服务端强制）。 */
  const report = async (scope: DisplayScope, range?: { from?: number; to?: number }): Promise<StatusReport> => {
    const snap = snapshot(scope);
    const lines: string[] = [];
    lines.push(`# TDA 状态报告（${new Date(snap.at).toISOString()}）`);
    lines.push('');
    lines.push(`范围：${scope.goalId ?? '全图'}　版本：${DISPLAY_VERSION}`);
    if (snap.degraded.length > 0) lines.push(`降级数据源：${snap.degraded.map(escapeHtml).join('、')}`);
    lines.push('');
    lines.push('## 目标进展');
    lines.push('');
    lines.push('| 目标 | 阶段 | 区域 | 任务 | 完成 |');
    lines.push('|---|---|---|---|---|');
    for (const goal of snap.overview.goals) {
      lines.push(
        `| ${escapeHtml(goal.objective)} | ${escapeHtml(`${goal.phase} / ${goal.stage}`)} | ${escapeHtml(goal.zone)} | ${goal.taskCount} | ${goal.completedCount} |`,
      );
    }
    lines.push('');
    lines.push('## 任务结果与证据回链');
    lines.push('');
    let evidenceCount = 0;
    for (const task of deps.taskPool.list(scope)) {
      if (task.outcome === undefined) continue;
      evidenceCount += 1;
      const evidence = task.evidence.length > 0 ? task.evidence.map((entry) => escapeHtml(entry)).join('、') : '（无）';
      lines.push(`- ${escapeHtml(task.id)}：${escapeHtml(task.outcome)}（证据：${evidence}）`);
    }
    if (evidenceCount === 0) lines.push('-（无已完成任务）');
    lines.push('');
    lines.push('## 预算与注意力');
    lines.push('');
    const counts = snap.overview.tasks;
    lines.push(
      `任务计数：ready=${counts.ready} executing=${counts.executing} awaitingApproval=${counts.awaitingApproval} verifying=${counts.verifying} blocked=${counts.blocked} completedToday=${counts.completedToday}`,
    );
    if (snap.overview.attention !== undefined) {
      lines.push(
        `注意力：${snap.overview.attention.consumedUnits}/${snap.overview.attention.quotaUnits}（${snap.overview.attention.zone}）`,
      );
    }
    if (snap.overview.drift !== undefined) {
      lines.push(`漂移：${snap.overview.drift.band}（趋势 [${snap.overview.drift.trend.join(', ')}]）`);
    }
    lines.push('');
    lines.push('## 待决审批');
    lines.push('');
    if (snap.approvals.length === 0) {
      lines.push('-（队列为空）');
    } else {
      for (const approval of snap.approvals) {
        lines.push(
          `- ${escapeHtml(approval.approvalId)}［${escapeHtml(approval.kind)}/${escapeHtml(approval.riskLevel)}］${escapeHtml(approval.subject)}：${escapeHtml(approval.summary)}`,
        );
      }
    }
    void range; // v1 报告=当前态快照；区间聚合随 U5 报告分发需求
    const markdown = lines.join('\n');
    // J7：落时间线——credential/source 服务端强制（调用方无法指定）
    await deps.timeline.append(
      { sessionId: deps.schedulerSessionId, actor: 'scheduler', at: clock() },
      { content: markdown, chunkType: 'fact', source: 'harness', credential: 'execution-verified' },
    );
    return markdown;
  };

  const startServer = (opts?: { port?: number; host?: string }): Promise<{ url: string; port: number }> => {
    const host = opts?.host ?? '127.0.0.1';
    // 不变量 2：非 loopback 一律拒绝（fail-loud，禁 0.0.0.0/公网 IP）
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new TdaError('DISPLAY_NON_LOOPBACK', `display 只允许绑定 loopback（拒绝 ${host}；0.0.0.0/公网 IP 是网络暴露面）`);
    }
    if (server !== undefined && listening) {
      return Promise.resolve({ url: boundUrl ?? `http://${host}:${boundPort}`, port: boundPort ?? 0 });
    }
    const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
      try {
        const url = new URL(request.url ?? '/', `http://${host}`);
        // 不变量 3：方法白名单（非 GET 一律 405，禁写路由）
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' }).end();
          return;
        }
        const json = (body: unknown, status = 200): void => {
          response
            .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            .end(JSON.stringify(body));
        };
        switch (url.pathname) {
          case '/':
            response
              .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
              .end(PAGE_HTML);
            return;
          case '/api/snapshot':
            json(snapshot(url.searchParams.get('scope') !== undefined ? { goalId: url.searchParams.get('scope') ?? undefined } : undefined));
            return;
          case '/api/report':
            void report({})
              .then((markdown) => {
                response
                  .writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' })
                  .end(markdown);
              })
              .catch(() => {
                // J9 fail-open：聚合失败返回 500 但服务存活
                response.writeHead(500, { 'Cache-Control': 'no-store' }).end();
              });
            return;
          case '/api/export/dot':
            response
              .writeHead(200, { 'Content-Type': 'text/vnd.graphviz; charset=utf-8', 'Cache-Control': 'no-store' })
              .end(deps.graph.export('dot'));
            return;
          case '/api/export/json':
            response
              .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
              .end(deps.graph.export('json'));
            return;
          case '/api/health':
            json({ ok: true, at: clock(), version: DISPLAY_VERSION });
            return;
          default:
            // 路由表白名单外一律 404
            response.writeHead(404, { 'Cache-Control': 'no-store' }).end();
            return;
        }
      } catch {
        // J9：handler 内任何异常不击穿进程
        try {
          response.writeHead(500, { 'Cache-Control': 'no-store' }).end();
        } catch {
          /* 响应已发送 */
        }
      }
    };
    return new Promise((resolve, reject) => {
      const created = http.createServer(handler);
      created.on('error', (error) => reject(error));
      created.listen(opts?.port ?? DISPLAY_DEFAULT_PORT, host, () => {
        const address = created.address() as AddressInfo;
        server = created;
        listening = true;
        boundPort = address.port;
        boundUrl = `http://${host}:${address.port}`;
        resolve({ url: boundUrl, port: address.port });
      });
    });
  };

  const stopServer = async (): Promise<void> => {
    if (server === undefined) return;
    const closing = server;
    server = undefined;
    listening = false;
    boundUrl = undefined;
    boundPort = undefined;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  };

  return {
    async initialize() {
      void snapshot(); // 预热（并尽早暴露聚合面问题）
    },
    startServer,
    stopServer,
    snapshot,
    report,
    serverStatus: () => ({
      listening,
      ...(boundUrl !== undefined ? { url: boundUrl } : {}),
      ...(boundPort !== undefined ? { port: boundPort } : {}),
    }),
    async dispose() {
      await stopServer();
    },
  };
}

export { PAGE_HTML };
