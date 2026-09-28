/**
 * domain 基座：TDA 状态总线的本地镜像实现。
 *
 * 契约镜像自 DSH storage（docs/subsystems/storage.md），IT0 自包含：
 *  - invalidRecords 缺省 = 'reject'（权威数据损坏即整域拒绝打开）
 *  - 'backup-and-skip' 仅用于派生数据（backend 移走损坏文档后继续）
 *  - 写路径时序：zod 校验 → backend 持久化 → 改内存 → 发 domain/changed
 *  - update 为原子 RMW，缺键抛 MISSING_KEY（不静默插入）
 */
import { z } from 'zod';
import { TdaError } from './types.ts';

export type InvalidRecordsPolicy = 'reject' | 'backup-and-skip';
export type TdaLayout = 'single' | 'per-record';

export interface TdaDomainSpec<Tables extends Record<string, z.ZodTypeAny>> {
  readonly name: string;
  readonly version: number;
  readonly tables: Tables;
  /** 缺省 'reject'；'backup-and-skip' 仅限派生表。 */
  readonly invalidRecords?: InvalidRecordsPolicy;
  readonly layout?: TdaLayout;
}

/** domain 名 / 表名：字母数字开头，允许中划线与下划线。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 表记录键与表名的分隔符（backend unit 内的复合键）。 */
export const RECORD_KEY_SEPARATOR = '\u0000';

export const compositeRecordKey = (table: string, key: string): string =>
  `${table}${RECORD_KEY_SEPARATOR}${key}`;

/** defineTdaDomain：模块加载即 fail-loud 的规格构造器（镜像 DSH defineDomain）。 */
export function defineTdaDomain<const Tables extends Record<string, z.ZodTypeAny>>(
  spec: TdaDomainSpec<Tables>,
): TdaDomainSpec<Tables> {
  if (!NAME_RE.test(spec.name)) {
    throw new TdaError('INVALID_DOMAIN_NAME', `domain 名 "${spec.name}" 不合法（需匹配 ${NAME_RE}）`);
  }
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new TdaError(
      'INVALID_DOMAIN_VERSION',
      `domain "${spec.name}" 版本必须为非负整数，收到 ${String(spec.version)}`,
    );
  }
  for (const tableName of Object.keys(spec.tables)) {
    if (!NAME_RE.test(tableName)) {
      throw new TdaError(
        'INVALID_TABLE_NAME',
        `domain "${spec.name}" 表名 "${tableName}" 不合法（需匹配 ${NAME_RE}）`,
      );
    }
  }
  if (
    spec.invalidRecords !== undefined &&
    spec.invalidRecords !== 'reject' &&
    spec.invalidRecords !== 'backup-and-skip'
  ) {
    throw new TdaError(
      'INVALID_INVALID_RECORDS_POLICY',
      `domain "${spec.name}" invalidRecords 非法：${String(spec.invalidRecords)}`,
    );
  }
  if (spec.layout !== undefined && spec.layout !== 'single' && spec.layout !== 'per-record') {
    throw new TdaError(
      'INVALID_LAYOUT',
      `domain "${spec.name}" layout 非法：${String(spec.layout)}（DSH 实际取值为 'single' | 'per-record'）`,
    );
  }
  return spec;
}

/** domain 变更记录（镜像 domain/changed 事件载荷；value 仅 put 携带新快照）。 */
export interface TdaDomainChange {
  readonly domain: string;
  /** '' 表示 global 槽；TDA 恒不使用 global（镜像完整性保留）。 */
  readonly table: string;
  readonly key: string;
  readonly operation: 'put' | 'deleted';
  readonly value?: unknown;
}

/** KV 表视图：同步读；写走 domain 写链（持久化 → 内存 → 事件）。 */
export interface TdaKvTable<V> {
  get(key: string): V | undefined;
  keys(): IterableIterator<string>;
  entries(): IterableIterator<[string, V]>;
  size(): number;
  put(key: string, value: V): Promise<void>;
  update(key: string, mutate: (current: V) => V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface TdaDomain<Tables extends Record<string, z.ZodTypeAny> = Record<string, z.ZodTypeAny>> {
  readonly name: string;
  table<K extends keyof Tables & string>(name: K): TdaKvTable<z.infer<Tables[K]>>;
  close(): Promise<void>;
}

/** backend 存储单元：承载一个 domain 的全部记录（json/sqlite 等实现）。 */
export interface TdaKvUnit {
  loadAll(): Map<string, unknown> | Promise<Map<string, unknown>>;
  putRecord(key: string, value: unknown): void | Promise<void>;
  deleteRecord(key: string): void | Promise<void>;
  /** 仅 backup-and-skip 需要：把损坏记录移出主存储。 */
  backupRecord?(key: string, value: unknown): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface TdaUnitDescriptor {
  readonly name: string;
  readonly version: number;
}

export interface TdaStorageBackend {
  open(descriptor: TdaUnitDescriptor): TdaKvUnit;
  close(): void | Promise<void>;
}

export interface OpenTdaDomainOptions {
  readonly backend: TdaStorageBackend;
  /** domain/changed 观察者（双写对账器经此接入）。 */
  readonly onChange?: (change: TdaDomainChange) => void;
  /** backup-and-skip 跳过损坏记录时的通知（供日志/测试断言）。 */
  readonly onInvalidRecord?: (info: { readonly table: string; readonly key: string; readonly reason: string }) => void;
}

/** TdaKvTableImpl 只经此窄接口访问 domain，避免泛型参数向表实现传染。 */
interface TdaDomainHost {
  persist(tableName: string, key: string, value: unknown): Promise<void>;
  remove(tableName: string, key: string): Promise<void>;
}

class TdaKvTableImpl<V> implements TdaKvTable<V> {
  private readonly domain: TdaDomainHost;
  private readonly tableName: string;
  private readonly schema: z.ZodTypeAny;
  private readonly store: Map<string, unknown>;

  // 显式字段声明（不用参数属性）：保持源码 erasable-syntax-only，
  // 使 Node 24 类型剥离可直接执行（kill -9 子进程零转译依赖）。
  constructor(domain: TdaDomainHost, tableName: string, schema: z.ZodTypeAny, store: Map<string, unknown>) {
    this.domain = domain;
    this.tableName = tableName;
    this.schema = schema;
    this.store = store;
  }

  private parseOrThrow(value: unknown): V {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new TdaError('INVALID_RECORD', `表 ${this.tableName} 记录校验失败：${result.error.message}`);
    }
    return result.data as V;
  }

  get(key: string): V | undefined {
    return this.store.get(key) as V | undefined;
  }

  keys(): IterableIterator<string> {
    return this.store.keys();
  }

  entries(): IterableIterator<[string, V]> {
    return this.store.entries() as IterableIterator<[string, V]>;
  }

  size(): number {
    return this.store.size;
  }

  async put(key: string, value: V): Promise<void> {
    const parsed = this.parseOrThrow(value);
    await this.domain.persist(this.tableName, key, parsed);
  }

  async update(key: string, mutate: (current: V) => V): Promise<void> {
    const current = this.get(key);
    if (current === undefined) {
      throw new TdaError('MISSING_KEY', `表 ${this.tableName} 更新缺键：${key}`);
    }
    const next = this.parseOrThrow(mutate(current));
    await this.domain.persist(this.tableName, key, next);
  }

  async delete(key: string): Promise<boolean> {
    if (!this.store.has(key)) return false;
    await this.domain.remove(this.tableName, key);
    return true;
  }
}

class TdaDomainImpl<Tables extends Record<string, z.ZodTypeAny>> implements TdaDomain<Tables> {
  readonly name: string;
  private readonly spec: TdaDomainSpec<Tables>;
  private readonly unit: TdaKvUnit;
  private readonly options: OpenTdaDomainOptions;
  private readonly stores = new Map<string, Map<string, unknown>>();
  private readonly tables = new Map<string, TdaKvTable<never>>();
  private closed = false;

  // 显式字段声明（不用参数属性）：保持源码 erasable-syntax-only。
  constructor(
    name: string,
    spec: TdaDomainSpec<Tables>,
    unit: TdaKvUnit,
    options: OpenTdaDomainOptions,
  ) {
    this.name = name;
    this.spec = spec;
    this.unit = unit;
    this.options = options;
    for (const tableName of Object.keys(spec.tables)) {
      this.stores.set(tableName, new Map());
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new TdaError('DOMAIN_CLOSED', `domain "${this.name}" 已关闭`);
    }
  }

  table<K extends keyof Tables & string>(name: K): TdaKvTable<z.infer<Tables[K]>> {
    this.ensureOpen();
    const cached = this.tables.get(name);
    if (cached) return cached as unknown as TdaKvTable<z.infer<Tables[K]>>;
    const schema = this.spec.tables[name];
    const store = this.stores.get(name);
    if (!schema || !store) {
      throw new TdaError('UNKNOWN_TABLE', `domain "${this.name}" 无表 "${name}"`);
    }
    const table: TdaKvTable<never> = new TdaKvTableImpl(this, name, schema, store);
    this.tables.set(name, table);
    return table as unknown as TdaKvTable<z.infer<Tables[K]>>;
  }

  /** 打开时装载：逐记录 zod 校验，按 invalidRecords 策略分级处置。 */
  async load(): Promise<void> {
    const loaded = await this.unit.loadAll();
    const policy = this.spec.invalidRecords ?? 'reject';
    for (const [composite, value] of loaded) {
      const sep = composite.indexOf(RECORD_KEY_SEPARATOR);
      const tableName = sep === -1 ? '' : composite.slice(0, sep);
      const recordKey = sep === -1 ? composite : composite.slice(sep + 1);
      const schema = tableName ? this.spec.tables[tableName] : undefined;
      if (!schema) {
        await this.handleInvalid(policy, tableName, recordKey, composite, value, '记录表名未在规格中登记');
        continue;
      }
      const result = schema.safeParse(value);
      if (result.success) {
        this.stores.get(tableName)?.set(recordKey, result.data);
        continue;
      }
      await this.handleInvalid(policy, tableName, recordKey, composite, value, result.error.message);
    }
  }

  private async handleInvalid(
    policy: InvalidRecordsPolicy,
    tableName: string,
    recordKey: string,
    composite: string,
    value: unknown,
    reason: string,
  ): Promise<void> {
    if (policy === 'reject') {
      throw new TdaError(
        'INVALID_RECORD',
        `domain "${this.name}" 权威记录损坏（表 ${tableName || '(未知)'} / 键 ${recordKey}）：${reason}`,
      );
    }
    // backup-and-skip：派生数据——备份后移出主存储并跳过
    if (this.unit.backupRecord) await this.unit.backupRecord(composite, value);
    await this.unit.deleteRecord(composite);
    this.options.onInvalidRecord?.({ table: tableName, key: recordKey, reason });
  }

  /** 写链：backend 持久化 → 改内存 → 发 domain/changed（提交点已过才发）。 */
  async persist(tableName: string, key: string, value: unknown): Promise<void> {
    this.ensureOpen();
    await this.unit.putRecord(compositeRecordKey(tableName, key), value);
    this.stores.get(tableName)?.set(key, value);
    this.options.onChange?.({
      domain: this.name,
      table: tableName,
      key,
      operation: 'put',
      value,
    });
  }

  async remove(tableName: string, key: string): Promise<void> {
    this.ensureOpen();
    await this.unit.deleteRecord(compositeRecordKey(tableName, key));
    this.stores.get(tableName)?.delete(key);
    this.options.onChange?.({ domain: this.name, table: tableName, key, operation: 'deleted' });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.unit.close();
  }
}

/** 打开 domain：开 unit → 装载校验 → 可用；严格序列，任一步失败即抛。 */
export async function openTdaDomain<Tables extends Record<string, z.ZodTypeAny>>(
  spec: TdaDomainSpec<Tables>,
  options: OpenTdaDomainOptions,
): Promise<TdaDomain<Tables>> {
  const unit = options.backend.open({ name: spec.name, version: spec.version });
  const domain = new TdaDomainImpl<Tables>(spec.name, spec, unit, options);
  await domain.load();
  return domain;
}
