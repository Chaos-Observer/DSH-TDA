/**
 * 周期触发求值：`TaskRecurrence` 的确定性时间推导（T0.2 J8）。
 *
 *  - interval：`fireAt + intervalMs`；落后多期时逐期补齐到"最新一次 due"
 *    （承 DSH schedule 语义：cold/busy 只补最新一次，不雪崩补跑）；
 *  - cron：标准 5 字段（分 时 日 月 周），最小粒度 1 分钟；
 *    支持通配、单值、区间、步长（步长语法 = 区间后接 "/数字"）、逗号列表；
 *    与时区、本地时间对齐（`Date` 本地时区，与 DSH schedule 一致）；
 *  - 日/周同时受限时取**或**（Vixie cron 语义），否则各受限字段取与；
 *  - 求值纯函数、无副作用、无随机：同输入同输出（replay-equivalence 前提）。
 */
import { TdaError } from '@tda/kernel';

export interface CronSpec {
  readonly raw: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  readonly daysOfWeek: readonly number[];
  /** 日/周字段是否为"受限"（非字面 `*`）——或语义的判据。 */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

const FIELD_LABELS = ['分', '时', '日', '月', '周'] as const;
const FIELD_RANGES: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

/** cron 求值上限：366 天（超出即判无解，如 `0 0 30 2 *`）。 */
const MAX_CRON_SCAN_MINUTES = 366 * 24 * 60;

function parseField(field: string, min: number, max: number, label: string): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '') {
      throw new TdaError('INVALID_CRON', `cron ${label} 字段含空项：${field}`);
    }
    const slash = part.indexOf('/');
    const rangePart = slash === -1 ? part : part.slice(0, slash);
    const stepPart = slash === -1 ? undefined : part.slice(slash + 1);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) {
        throw new TdaError('INVALID_CRON', `cron ${label} 字段步长非法：${part}`);
      }
      step = Number(stepPart);
      if (step < 1) throw new TdaError('INVALID_CRON', `cron ${label} 字段步长须 ≥1：${part}`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(rangePart)) {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max;
    } else if (/^\d+-\d+$/.test(rangePart)) {
      const [a, b] = rangePart.split('-') as [string, string];
      lo = Number(a);
      hi = Number(b);
    } else {
      throw new TdaError('INVALID_CRON', `cron ${label} 字段项非法：${part}`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new TdaError('INVALID_CRON', `cron ${label} 字段越界（允许 ${min}-${max}）：${part}`);
    }
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** 解析标准 5 字段 cron；不合法即抛 INVALID_CRON（fail-loud）。 */
export function parseCron(raw: string): CronSpec {
  const fields = raw.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new TdaError('INVALID_CRON', `cron 需 5 字段（分 时 日 月 周），收到 ${fields.length} 个：${raw}`);
  }
  const parsed = fields.map((field, index) => {
    const range = FIELD_RANGES[index];
    const label = FIELD_LABELS[index];
    if (range === undefined || label === undefined) {
      throw new TdaError('INVALID_CRON', `cron 字段序号越界：${index}`);
    }
    return parseField(field, range[0], range[1], label);
  });
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as [
    number[],
    number[],
    number[],
    number[],
    number[],
  ];
  return {
    raw: raw.trim(),
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

/** 语法可用性探针（zod schema 层用；不抛，返回布尔）。 */
export function isValidCron(raw: string): boolean {
  try {
    parseCron(raw);
    return true;
  } catch {
    return false;
  }
}

function cronMatches(spec: CronSpec, at: Date): boolean {
  if (!spec.months.includes(at.getMonth() + 1)) return false;
  if (!spec.hours.includes(at.getHours())) return false;
  if (!spec.minutes.includes(at.getMinutes())) return false;
  const domOk = spec.daysOfMonth.includes(at.getDate());
  const dowOk = spec.daysOfWeek.includes(at.getDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

/** 下一个命中时刻（毫秒，本地时区，分钟对齐）；无解抛 INVALID_CRON。 */
export function nextCronAfter(cron: CronSpec | string, from: number): number {
  const spec = typeof cron === 'string' ? parseCron(cron) : cron;
  let cursor = Math.floor(from / 60_000) * 60_000 + 60_000;
  for (let scanned = 0; scanned < MAX_CRON_SCAN_MINUTES; scanned += 1) {
    if (cronMatches(spec, new Date(cursor))) return cursor;
    cursor += 60_000;
  }
  throw new TdaError('INVALID_CRON', `cron 在 366 天内无解：${spec.raw}`);
}

export interface RecurrenceLike {
  readonly kind: 'interval' | 'cron';
  readonly intervalMs?: number | undefined;
  readonly cron?: string | undefined;
  readonly maxRuns?: number | undefined;
  readonly endAt?: number | undefined;
}

/**
 * 自基准时刻推进到"下一次 due"，落后多期时补齐（cold/busy 只补最新一次）。
 * `at` 为本次触发时刻（首次调度传 now）。
 */
export function nextRecurrenceAfter(recurrence: RecurrenceLike, at: number, now: number): number {
  if (recurrence.kind === 'interval') {
    const interval = recurrence.intervalMs;
    if (interval === undefined || interval < 1_000) {
      throw new TdaError('INVALID_RECURRENCE', 'interval 周期必须 ≥1000ms');
    }
    let next = at + interval;
    let guard = 0;
    while (next <= now && guard < 1_000_000) {
      next += interval;
      guard += 1;
    }
    return next;
  }
  const cron = recurrence.cron;
  if (cron === undefined) {
    throw new TdaError('INVALID_RECURRENCE', 'cron 周期必须携带 cron 表达式');
  }
  let next = nextCronAfter(cron, at);
  let guard = 0;
  while (next <= now && guard < MAX_CRON_SCAN_MINUTES) {
    next = nextCronAfter(cron, next);
    guard += 1;
  }
  return next;
}
