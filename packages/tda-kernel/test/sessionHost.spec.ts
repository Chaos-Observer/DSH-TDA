/**
 * 门2/门4 · 会话主机纯投影与 fork seed 不变量回归（IT4 / T0.7）。
 *
 * 覆盖：`deriveMessages` 只投影 conversation（**log-only 纯净**：TDA 事件永不进
 *      模型可见面）/ 轮次投影与开放轮次识别（resume 合成 closer 的依据）/
 *      seed 不变量六条各带拒绝用例（开放轮次内边界、前缀分歧、计数不实、
 *      seq 不连续、marker 缺失/位置错、TDA 事件超集）。
 */
import { describe, expect, it } from 'vitest';
import {
  checkSeedInvariants,
  deriveMessages,
  openTurns,
  projectTurns,
  type HostRecord,
} from '../src/index.ts';

const tda = (seq: number, businessId = 'goal-1'): HostRecord => ({
  seq,
  kind: 'tda',
  at: seq,
  family: 'goalTree/change',
  businessId,
  payload: { id: businessId },
});

const turnStart = (seq: number, turn: number): HostRecord => ({ seq, kind: 'turn/start', at: seq * 10, turn });
const turnEnd = (seq: number, turn: number): HostRecord => ({
  seq,
  kind: 'turn/end',
  at: seq * 10,
  turn,
  outcome: 'success',
});
const message = (seq: number, turn: number, role: 'user' | 'assistant' | 'tool', content: string): HostRecord => ({
  seq,
  kind: 'conversation',
  at: seq * 10,
  turn,
  role,
  content,
});
const seedEnd = (seq: number, note = 'fork seed'): HostRecord => ({ seq, kind: 'session/end-seed', at: seq * 10, note });

/** 父会话：两轮闭合 + 一条 TDA 事件（轮 1 内）。 */
const parent: readonly HostRecord[] = [
  turnStart(1, 1),
  message(2, 1, 'user', '第一问'),
  tda(3, 'task-1'),
  message(4, 1, 'assistant', '第一答'),
  turnEnd(5, 1),
  turnStart(6, 2),
  message(7, 2, 'user', '第二问'),
  message(8, 2, 'assistant', '第二答'),
  turnEnd(9, 2),
];

describe('会话主机 · 投影（log-only 纯净的结构保证）', () => {
  it('deriveMessages 只取 conversation：TDA 事件永不进模型可见面', () => {
    const messages = deriveMessages(parent);
    expect(messages.map((entry) => `${entry.role}:${entry.content}`)).toEqual([
      'user:第一问',
      'assistant:第一答',
      'user:第二问',
      'assistant:第二答',
    ]);
    // 反向断言：任何 TDA 事件的 payload/businessId 不得出现在消息面
    const dump = JSON.stringify(messages);
    expect(dump).not.toContain('goal-1');
    expect(dump).not.toContain('task-1');
  });

  it('轮次投影与开放轮次识别（resume 合成 closer 的依据）', () => {
    const turns = projectTurns(parent);
    expect(turns).toEqual([
      { turn: 1, startedSeq: 1, endedSeq: 5, closedBy: 'turn/end' },
      { turn: 2, startedSeq: 6, endedSeq: 9, closedBy: 'turn/end' },
    ]);
    expect(openTurns(parent)).toEqual([]);

    const crashed: readonly HostRecord[] = [...parent, turnStart(10, 3), message(11, 3, 'user', '第三问')];
    expect(openTurns(crashed)).toEqual([3]);
    const resumed: readonly HostRecord[] = [
      ...crashed,
      { seq: 12, kind: 'interrupted', at: 120, turn: 3, reason: '宿主重启' },
    ];
    expect(openTurns(resumed)).toEqual([]);
    expect(projectTurns(resumed).at(-1)).toMatchObject({ turn: 3, closedBy: 'interrupted', endedSeq: 12 });
  });
});

describe('fork seed 不变量（§4.1-6 六条）', () => {
  const forkTo = (boundary: number): { child: readonly HostRecord[]; inheritedEventCount: number } => {
    const end = projectTurns(parent).find((turn) => turn.turn === boundary)?.endedSeq ?? 0;
    const prefix = parent.filter((record) => record.seq <= end);
    const child = [...prefix.map((record, index) => ({ ...record, seq: index + 1 })), seedEnd(end + 1)];
    return { child, inheritedEventCount: prefix.length };
  };

  it('balanced 前缀 + 计数精确 + marker 合规 → 通过', () => {
    const { child, inheritedEventCount } = forkTo(2);
    expect(checkSeedInvariants({ parent, child, boundary: 2, inheritedEventCount })).toEqual({
      ok: true,
      violations: [],
    });
    // 子会话重新编号后，模型可见前缀与父会话等值（验收 4 的"前缀等值"）
    const parentMessages = deriveMessages(parent).map((entry) => entry.content);
    const childMessages = deriveMessages(child).map((entry) => entry.content);
    expect(childMessages).toEqual(parentMessages);
  });

  it('开放轮次内边界被拒（禁开放轮次内前缀）', () => {
    const crashed: readonly HostRecord[] = [...parent, turnStart(10, 3)];
    const { child, inheritedEventCount } = forkTo(3);
    const report = checkSeedInvariants({ parent: crashed, child, boundary: 3, inheritedEventCount });
    expect(report.ok).toBe(false);
    expect(report.violations.join(' ')).toContain('未闭合');
  });

  it('不存在的边界轮次被拒', () => {
    const { child, inheritedEventCount } = forkTo(2);
    const report = checkSeedInvariants({ parent, child, boundary: 9, inheritedEventCount });
    expect(report.violations.join(' ')).toContain('不存在');
  });

  it('前缀分歧 / 计数不实 / seq 不连续 / marker 缺失 各被拒', () => {
    const { child, inheritedEventCount } = forkTo(2);
    // ① 前缀被篡改
    const tampered = child.map((record, index) =>
      index === 1 ? { ...record, content: '被改过的第一问' } : record,
    ) as readonly HostRecord[];
    expect(checkSeedInvariants({ parent, child: tampered, boundary: 2, inheritedEventCount }).violations.join(' ')).toContain(
      '与父会话前缀分歧',
    );
    // ② 计数不实
    expect(
      checkSeedInvariants({ parent, child, boundary: 2, inheritedEventCount: inheritedEventCount + 3 }).violations.join(' '),
    ).toContain('inheritedEventCount');
    // ③ seq 不连续
    const gapped = child.map((record, index) => (index >= 2 ? { ...record, seq: record.seq + 1 } : record)) as readonly HostRecord[];
    expect(checkSeedInvariants({ parent, child: gapped, boundary: 2, inheritedEventCount }).violations.join(' ')).toContain(
      'seq 不连续',
    );
    // ④ marker 缺失
    const noMarker = child.filter((record) => record.kind !== 'session/end-seed');
    expect(
      checkSeedInvariants({ parent, child: noMarker, boundary: 2, inheritedEventCount: noMarker.length }).violations.join(' '),
    ).toContain('session/end-seed');
  });

  it('子会话混入父前缀之外的 TDA 事件被拒（关系不因 fork 失真）', () => {
    const { child, inheritedEventCount } = forkTo(2);
    const injected = [
      ...child.slice(0, 2),
      tda(9, 'goal-injected'),
      ...child.slice(2).map((record) => ({ ...record, seq: record.seq + 1 })),
    ] as readonly HostRecord[];
    const report = checkSeedInvariants({
      parent,
      child: injected,
      boundary: 2,
      inheritedEventCount: inheritedEventCount + 1,
    });
    expect(report.violations.join(' ')).toContain('goal-injected');
  });

  it('seed marker 之后不得再有继承的 TDA 事件', () => {
    const { child, inheritedEventCount } = forkTo(2);
    const after = [...child, tda(child.length + 1, 'task-late')] as readonly HostRecord[];
    const report = checkSeedInvariants({
      parent,
      child: after,
      boundary: 2,
      inheritedEventCount: inheritedEventCount + 1,
    });
    expect(report.violations.join(' ')).toContain('seed marker 之后');
  });
});

describe('fork seed · 前缀比对口径（实测缺陷回归）', () => {
  it('键序无关：记录被重新拼装（键序变化）仍判等值', () => {
    // 同一份数据、不同键序 —— 直接 JSON.stringify 会误判成分歧
    const parent: readonly HostRecord[] = [
      { seq: 1, kind: 'turn/start', at: 10, turn: 0 },
      { seq: 2, kind: 'conversation', at: 20, turn: 0, role: 'user', content: '问' },
      { seq: 3, kind: 'turn/end', at: 30, turn: 0, outcome: 'success' },
    ];
    // 子会话按 fork 的方式重排键序（展开后补 seq/sessionId）
    const child = parent.map((record, index) => ({
      ...(index === 1
        ? { role: 'user', content: '问', turn: 0, at: 20, kind: 'conversation' as const, seq: index + 1 }
        : { ...record, seq: index + 1 }),
    })) as readonly HostRecord[];
    const withMarker = [...child, { seq: child.length + 1, kind: 'session/end-seed', at: 40, note: 'fork' }] as readonly HostRecord[];
    const report = checkSeedInvariants({ parent, child: withMarker, boundary: 0, inheritedEventCount: 3 });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('sessionId 差异不算分歧（fork 换会话 id 是 fork 的语义）', () => {
    const parent: readonly HostRecord[] = [
      { seq: 1, kind: 'turn/start', at: 10, turn: 0 },
      { seq: 2, kind: 'turn/end', at: 20, turn: 0, outcome: 'success' },
    ];
    const child = [
      ...parent.map((record, index) => ({ ...record, seq: index + 1, sessionId: 'sess-child' })),
      { seq: 3, kind: 'session/end-seed', at: 30, note: 'fork' },
    ] as readonly HostRecord[];
    const report = checkSeedInvariants({ parent, child, boundary: 0, inheritedEventCount: 2 });
    expect(report.violations).toEqual([]);
  });

  it('载荷内容真的不同 → 仍判分歧（口径放宽不等于不查）', () => {
    const parent: readonly HostRecord[] = [
      { seq: 1, kind: 'turn/start', at: 10, turn: 0 },
      { seq: 2, kind: 'conversation', at: 20, turn: 0, role: 'user', content: '原始内容' },
      { seq: 3, kind: 'turn/end', at: 30, turn: 0, outcome: 'success' },
    ];
    const child = [
      ...parent.map((record, index) => ({ ...record, seq: index + 1, sessionId: 'sess-child' })),
      { seq: 4, kind: 'session/end-seed', at: 40, note: 'fork' },
    ] as readonly HostRecord[];
    const tampered = child.map((record, index) => (index === 1 ? { ...record, content: '被改过' } : record)) as readonly HostRecord[];
    const report = checkSeedInvariants({ parent, child: tampered, boundary: 0, inheritedEventCount: 3 });
    expect(report.violations.join(' ')).toContain('分歧');
  });
});
