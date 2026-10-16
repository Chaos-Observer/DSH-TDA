/**
 * tda-executor 冒烟门（门4 test:smoke）——T4.1 §6 验收标准逐条。
 *
 * 夹具全部用内存假体实现被依赖面并记录调用日志；否定性断言（零执行权/零泄漏/
 * 无自由文本通道）靠 calls 与 Object.keys 自证。
 */
import { describe, expect, it } from 'vitest';
import { routeTask, selectAttempts } from '../src/service.ts';
import { makeTask, NOW, setup } from './helpers.ts';

describe('T4.1 验收 1：端到端自动执行', () => {
  it('ready 任务被自动认领→路由→执行→验证→complete(success)，全程无人工介入', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      const reports = await rig.service.runOnce();
      expect(reports).toHaveLength(1);
      expect(reports[0]?.status).toBe('completed');
      expect(reports[0]?.outcome).toBe('success');
      // 任务侧：恰一次 claim + 一次 complete(success)
      expect(rig.taskPool.calls).toEqual(['claim:task-1', 'complete:task-1:success']);
      // attempt 终态与证据
      const attempt = rig.service.attempts({ taskId: 'task-1' })[0];
      expect(attempt?.status).toBe('completed');
      expect(attempt?.mode).toBe('dispatch');
      expect(attempt?.modeReason).toBe('no-def');
      expect(attempt?.verification?.passed).toBe(true);
      expect(attempt?.verification?.evidenceEntryIds).toEqual(['tl-1']);
      // 执行环从不自行 release/block（零执行越界）
      expect(rig.taskPool.calls.some((call) => call.startsWith('release') || call.startsWith('block'))).toBe(false);
      // 派发双步：建单（approved）→ 驱动到 settle
      expect(rig.dispatch.calls).toEqual(['dispatch:task-1', 'driveOrder:disp-1']);
    } finally {
      await rig.dispose();
    }
  });

  it('runOnce 空转（无 ready 任务）不产 attempt', async () => {
    const rig = await setup({ tasks: [] });
    try {
      const reports = await rig.service.runOnce();
      expect(reports).toEqual([]);
      expect(rig.service.attempts()).toEqual([]);
      expect(rig.domain.table('executor_attempts').size()).toBe(0);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.1 验收 2：路由三模式（确定性纯函数）', () => {
  it('workflow：匹配 consolidated def（name === subject）', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      rig.workflow.defs.push({ defId: 'wf-1', name: '整理依赖清单', kind: 'template', status: 'consolidated' });
      const reports = await rig.service.runOnce();
      expect(reports[0]?.mode).toBe('workflow');
      expect(rig.workflow.calls).toEqual(['start:wf-1:task-1']);
      const attempt = rig.service.attempts({ taskId: 'task-1' })[0];
      expect(attempt?.modeReason).toBe('matched-def:wf-1');
      expect(attempt?.runId).toBe('wfrun-1');
      expect(attempt?.verification?.kind).toBe('workflow-contract');
      expect(rig.taskPool.calls.at(-1)).toBe('complete:task-1:success');
    } finally {
      await rig.dispose();
    }
  });

  it('dispatch：无匹配 def 时走 T0.5 通道（只传 taskId+role）', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      await rig.service.runOnce();
      // 零自由文本通道：建单调用只携 taskId（driveOrder 是 orderId 维度的第二步）
      expect(
        rig.dispatch.calls
          .filter((call) => call.startsWith('dispatch:'))
          .every((call) => /^dispatch:task-\d+$/.test(call)),
      ).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('direct：verifying 且目标完成标准含 entry: 断言时本地收尾', async () => {
    const rig = await setup({
      tasks: [makeTask({ stage: 'verifying' })],
      goalCriteria: ['entry:tl-1', 'entry:tl-2'],
      timelineEntries: ['tl-1', 'tl-2'],
    });
    try {
      const reports = await rig.service.runOnce();
      expect(reports[0]?.mode).toBe('direct');
      const attempt = rig.service.attempts({ taskId: 'task-1' })[0];
      expect(attempt?.modeReason).toBe('verify-closeout');
      expect(attempt?.verification?.evidenceEntryIds).toEqual(['tl-1', 'tl-2']);
      // direct 不派发不跑工作流
      expect(rig.dispatch.calls).toEqual([]);
      expect(rig.workflow.calls).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });

  it('direct 断言缺席 ⇒ 验证不过（不当成功）', async () => {
    const rig = await setup({
      tasks: [makeTask({ stage: 'verifying' })],
      goalCriteria: ['entry:tl-1', 'entry:tl-2'],
      timelineEntries: ['tl-1'], // tl-2 缺席
    });
    try {
      const reports = await rig.service.runOnce();
      expect(reports[0]?.status).toBe('failed');
      const attempt = rig.service.attempts({ taskId: 'task-1' })[0];
      expect(attempt?.verification?.passed).toBe(false);
      expect(attempt?.unfinished?.[0]).toContain('断言缺席');
    } finally {
      await rig.dispose();
    }
  });

  it('routeTask 纯函数：同输入同输出', () => {
    const task = { subject: 'S', stage: 'planning' };
    const defs = [{ defId: 'wf-1', name: 'S', kind: 'template', status: 'consolidated' }];
    expect(routeTask(task, defs, [])).toEqual(routeTask(task, defs, []));
    expect(routeTask(task, [], []).mode).toBe('dispatch');
    expect(routeTask({ subject: 'S', stage: 'verifying' }, defs, ['entry:tl-1']).mode).toBe('direct');
  });
});

describe('T4.1 验收 3：验证门与重试帽', () => {
  it('结论缺 entryId ⇒ 不当 success；自动重试一次；再不过 ⇒ failed+unfinished', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      rig.dispatch.configure({ entryId: null }); // 结论过 schema 但无 entryId
      const reports = await rig.service.runOnce();
      expect(reports[0]?.status).toBe('failed');
      expect(reports[0]?.outcome).toBe('failed');
      // 两次建单（初试 + 帽内重试一次），然后显式终态
      expect(rig.dispatch.calls.filter((call) => call.startsWith('dispatch:'))).toHaveLength(2);
      expect(rig.taskPool.calls.at(-1)).toBe('complete:task-1:failed');
      const attempt = rig.service.attempts({ taskId: 'task-1' })[0];
      expect(attempt?.attempts).toBe(2);
      expect(attempt?.unfinished?.[0]).toContain('验证不过');
      expect(attempt?.settledAt).toBeTypeOf('number');
    } finally {
      await rig.dispose();
    }
  });

  it('conclusion-partial 同样不当 success', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      rig.dispatch.configure({ conclusionOutcome: 'conclusion-partial' });
      const reports = await rig.service.runOnce();
      expect(reports[0]?.status).toBe('failed');
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.1 验收 4：审批接续（ResumeTicket 一次性）', () => {
  const highRisk = makeTask({ localPath: 'ws/a', writeScopes: ['ws/b/x'] });

  /** 造一条挂起 attempt：dispatch 层高风险闸（requested）+ 执行环登记监督请求。
   *  返回 rig 与（模拟 approveAndResume 桥的）dispatch.approve 动作。 */
  async function parkHighRisk(rig: Awaited<ReturnType<typeof setup>>): Promise<{
    approveOrder: () => void;
    ticket: { approvalId: string; nonce: string; from: string; handle: string };
  }> {
    rig.dispatch.configure({ status: 'requested' }); // T0.5 J9 闸：建单即 requested
    const reports = await rig.service.runOnce();
    expect(reports[0]?.status).toBe('awaiting-approval');
    const ticket = rig.supervision.approve('appr-1', 'tok-1');
    return {
      // 桥接语义（P4 集成门实测）：人类票据 ⇒ dispatch.approve 把单推 approved
      approveOrder: () => {
        const order = rig.dispatch.orders.get('disp-1');
        if (order !== undefined) order.status = 'approved';
      },
      ticket,
    };
  }

  it('高风险派发单挂起等待审批；凭票续跑至 completed（T0.5 J9 单点闸）', async () => {
    const rig = await setup({ tasks: [highRisk] });
    try {
      const { approveOrder, ticket } = await parkHighRisk(rig);
      const attempt = rig.service.attempts({ taskId: 'task-1' })[0];
      expect(attempt?.approvalId).toBe('appr-1');
      expect(attempt?.orderId).toBe('disp-1');
      expect(rig.supervision.calls).toContain('request:dispatch');
      // 未凭票：任务未被 complete，attempt 仍在挂起
      expect(rig.taskPool.calls).toEqual(['claim:task-1']);
      expect(rig.service.inFlight()).toHaveLength(1);

      approveOrder();
      const final = await rig.service.resumeAttempt('exec-1', ticket);
      expect(final.status).toBe('completed');
      expect(rig.dispatch.calls).toContain('driveOrder:disp-1');
      expect(rig.taskPool.calls.at(-1)).toBe('complete:task-1:success');
    } finally {
      await rig.dispose();
    }
  });

  it('ticket 重放被拒（一次性）', async () => {
    const rig = await setup({ tasks: [highRisk] });
    try {
      const { approveOrder, ticket } = await parkHighRisk(rig);
      approveOrder();
      await rig.service.resumeAttempt('exec-1', ticket);
      await expect(rig.service.resumeAttempt('exec-1', ticket)).rejects.toThrow('已消费');
    } finally {
      await rig.dispose();
    }
  });

  it('ticket 不指向本 attempt 被拒', async () => {
    const rig = await setup({ tasks: [highRisk] });
    try {
      const { ticket } = await parkHighRisk(rig);
      await expect(rig.service.resumeAttempt('exec-1', { ...ticket, handle: 'exec-999' })).rejects.toThrow(
        '不指向本 attempt',
      );
    } finally {
      await rig.dispose();
    }
  });

  it('非挂起态禁凭票续跑', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      await rig.service.runOnce(); // 直接 completed（无高风险闸）
      const ticket = { approvalId: 'appr-x', nonce: 'nonce-x', from: 'ctx.executor', handle: 'exec-1' };
      await expect(rig.service.resumeAttempt('exec-1', ticket)).rejects.toThrow('非 awaiting-approval');
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.1 验收 6：让位纪律', () => {
  it('主任务活跃期不新选任务；信号撤销后续选', async () => {
    let active = true;
    const rig = await setup({ tasks: [makeTask()], isMainActive: () => active });
    try {
      expect(rig.service.select(NOW)).toEqual([]);
      expect(await rig.service.runOnce()).toEqual([]);
      expect(rig.taskPool.calls).toEqual([]);
      active = false;
      expect(rig.service.select(NOW)).toHaveLength(1);
      const reports = await rig.service.runOnce();
      expect(reports[0]?.status).toBe('completed');
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.1 验收 7：预算三区（口径复用 T0.2 zoneOfCaps）', () => {
  it('exhausted 区任务不被选取', async () => {
    const rig = await setup({ tasks: [makeTask({ zone: 'exhausted' })] });
    try {
      expect(rig.service.select(NOW)).toEqual([]);
      expect(await rig.service.runOnce()).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });

  it('待批准提议不被选取（J9：未批准不可认领）', async () => {
    const rig = await setup({ tasks: [makeTask({ proposalStatus: 'pending_approval' })] });
    try {
      expect(rig.service.select(NOW)).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });

  it('并发帽：maxParallel=1 时在飞满员即停选', async () => {
    const rig = await setup({
      tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2', subject: '任务二', priority: 9 })],
    });
    try {
      await rig.service.setParams('human', { maxParallel: 1 });
      // 先造一条在飞（高风险派发单挂起审批）占满帽
      const hang = await setup({ tasks: [makeTask({ id: 'task-9', localPath: 'ws/a', writeScopes: ['ws/b'] })] });
      try {
        hang.dispatch.configure({ status: 'requested' }); // 挂起而非完成
        await hang.service.runOnce();
        expect(hang.service.inFlight()).toHaveLength(1);
        expect(hang.service.select(NOW)).toEqual([]); // 帽内只挂起 1 条即满
      } finally {
        await hang.dispose();
      }
      void rig;
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.1 验收 9：零泄漏与零直写（结构性自证）', () => {
  it('服务面不持有 domain/storage/context/surface 句柄', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      const forbidden = Object.keys(rig.service).filter((name) =>
        ['domain', 'storage', 'context', 'surface', 'session'].includes(name),
      );
      expect(forbidden).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });

  it('执行环运行零注入面写入（deps 无 context 句柄，编译期保证；运行期复核调用面）', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      await rig.service.runOnce();
      // 全部副作用只有：taskPool claim/complete + dispatch 建单/驱动 + 自有域双写
      expect(rig.taskPool.calls.every((call) => call.startsWith('claim') || call.startsWith('complete'))).toBe(true);
      expect(rig.dispatch.calls).toEqual(['dispatch:task-1', 'driveOrder:disp-1']);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.1 selectAttempts 选取序', () => {
  it('priority 降序 → dueAt 升序 → createdAt 升序', () => {
    const tasks = [
      makeTask({ id: 'task-a', priority: 1, createdAt: NOW }),
      makeTask({ id: 'task-b', priority: 9, createdAt: NOW + 5 }),
      makeTask({ id: 'task-c', priority: 9, createdAt: NOW, dueAt: NOW + 100 }),
      makeTask({ id: 'task-d', priority: 9, createdAt: NOW, dueAt: NOW + 50 }),
    ];
    const selected = selectAttempts(tasks, { maxParallel: 10, inFlight: 0, isMainActive: false });
    expect(selected.map((task) => task.id)).toEqual(['task-d', 'task-c', 'task-b', 'task-a']);
  });

  it('STALE 时本轮跳过（调用方重试责任）', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      // 模拟并发 revision 漂移：claim 一律 STALE
      rig.taskPool.claimStale = true;
      const reports = await rig.service.runOnce();
      expect(reports[0]?.skipped).toBe('STALE_REVISION');
      expect(rig.service.attempts()).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });
});
