import { readFileSync, writeFileSync } from 'node:fs';

const steps = [];
const patch = (p, label, from, to) => {
  let s = readFileSync(p, 'utf8');
  if (!s.includes(from)) {
    steps.push(`MISS ${label}`);
    return;
  }
  s = s.replace(from, to);
  writeFileSync(p, s);
  steps.push(`ok   ${label}`);
};

// ★ J3"双轨判带"的实现缺口：只在 composite 越 drift 带才路由，会让
//   "单维漂移被其余三维抵消"的情形漏报——这正是双轨要防的。
patch(
  'src/service.ts',
  '双轨路由',
  `        const routed = level === 'drift' ? routeAction(scores, hysteresis) : undefined;`,
  `        // J3 双轨：composite 越 drift 带 **或** 任一指标（经滞回）越限都触发——
        // 防止"四指标互相抵消掩盖单维漂移"（如约束独自崩掉而总量尚可）
        const anyMetric = DRIFT_METRICS.some((metric) => hysteresis[metric]);
        const routed = level === 'drift' || anyMetric ? routeAction(scores, hysteresis) : undefined;`,
);

// test1：task-2 不能持有 owner（否则"报 executing 但无 in-progress"不成立）
patch(
  'test/gate.spec.ts',
  'test1 去 owner',
  `        { id: 'task-2', goalId: 'goal-1', phase: 'active', stage: 'executing', ownerId: 'sess-x', blockedCode: 'constraint-scope' },`,
  `        { id: 'task-2', goalId: 'goal-1', phase: 'active', stage: 'executing', blockedCode: 'constraint-scope' },`,
);

console.log(steps.join('\n'));
