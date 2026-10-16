/**
 * P5.1 · SQLite backend 适配器（TDA TdaStorageBackend ↔ DSH 兼容物理布局）。
 *
 * 设计裁定（详见《DSH真装配-勘察与施工图》§2/§5 P5.0 补记）：
 *  - **不用 DSH SqliteStorageBackend 本体**：它 openUnit 异步、tables 须 open 时预知、
 *    版本严格相等——与 TDA 同步读内存镜像/惰性建表/compatibleVersions 三层语义冲突。
 *    本适配器用 node:sqlite 同步实现 **DSH 兼容物理布局**（user_version=1 + units 表 +
 *    `u_<unit>_<table>` 记录表，DDL 同构抄录 vendor schema.ts）——TDA 写出的 db 文件
 *    可被 DSH 后端直接打开（P5.4 DSH Storage Service 接管的前提）。
 *  - **单表承载复合键**：TDA unit 用 `table\0key` 复合键单 unit 载多表（domain.ts
 *    RECORD_KEY_SEPARATOR），适配到 DSH 单元的一张 `records` 表（\u0000 在 sqlite
 *    TEXT 合法）；省去 per-table 建表的预知问题。
 *  - **域名映射**：`tda-task-pool` → `tda_task_pool`（DSH UNIT_NAME_RE 禁连字符）；
 *    权威域名不变，仅介质层映射。
 *  - **版本兼容集**：DSH unit 层版本严格相等；TDA compatibleVersions（旧版可开）
 *    在本适配器补齐——版本不符但在兼容集 ⇒ 接受并重戳到当前版（与 jsonBackend 语义一致）。
 *  - **backupRecord**：backup-and-skip 把损坏记录挪到同单元 `records_backup` 影子表
 *    （DSH 主表布局不受影响；jsonBackend 语义对偶：.backup.json 旁文件）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TdaError } from './types.ts';
import { RECORD_KEY_SEPARATOR } from './domain.ts';
import type { TdaKvUnit, TdaStorageBackend, TdaUnitDescriptor } from './domain.ts';

/** DSH sqlite 物理布局版本（vendor schema.ts STORAGE_SQLITE_SCHEMA_VERSION 同值）。 */
const STORAGE_SQLITE_SCHEMA_VERSION = 1;

/** DSH UNIT_NAME_RE：禁连字符——介质层把 `-` 映射为 `_`。 */
const toMediumUnitName = (name: string): string => name.replaceAll('-', '_');

const recordTableName = (unit: string): string => `u_${unit}_records`;
const backupTableName = (unit: string): string => `u_${unit}_records_backup`;

/**
 * 复合键介质编码：domain 层的 `table\0key` 含 \u0000——node:sqlite 绑定 UTF-8
 * 转换会截断 NUL（实测，这正是 DSH 用多表而非复合键的原因）。介质侧改
 * **长度前缀**：`<table.length>:<table><key>`（无歧义、无控制字符）。
 */
const encodeComposite = (composite: string): string => {
  const sep = composite.indexOf(RECORD_KEY_SEPARATOR);
  const table = sep === -1 ? '' : composite.slice(0, sep);
  const key = sep === -1 ? composite : composite.slice(sep + 1);
  return `${table.length}:${table}${key}`;
};

const decodeComposite = (encoded: string): string => {
  const colon = encoded.indexOf(':');
  if (colon === -1) throw new TdaError('MALFORMED_MEDIUM', `复合键缺长度前缀：${encoded.slice(0, 40)}`);
  const tableLength = Number(encoded.slice(0, colon));
  if (!Number.isInteger(tableLength) || tableLength < 0 || encoded.length < colon + 1 + tableLength) {
    throw new TdaError('MALFORMED_MEDIUM', `复合键长度前缀非法：${encoded.slice(0, 40)}`);
  }
  const table = encoded.slice(colon + 1, colon + 1 + tableLength);
  const key = encoded.slice(colon + 1 + tableLength);
  return table === '' ? key : `${table}${RECORD_KEY_SEPARATOR}${key}`;
};

class SqliteUnit implements TdaKvUnit {
  /** 可擦除纪律：kill -9 子进程走 Node 类型剥离直跑，禁参数属性（constructor private readonly）。 */
  private readonly db: DatabaseSync;
  private readonly mediumUnit: string;

  constructor(db: DatabaseSync, mediumUnit: string) {
    this.db = db;
    this.mediumUnit = mediumUnit;
  }

  loadAll(): Map<string, unknown> {
    const rows = this.db
      .prepare(`SELECT key, value FROM "${recordTableName(this.mediumUnit)}"`)
      .all() as { key: string; value: string }[];
    const map = new Map<string, unknown>();
    for (const row of rows) {
      const composite = decodeComposite(row.key);
      let value: unknown;
      try {
        value = JSON.parse(row.value) as unknown;
      } catch {
        // 对齐 jsonBackend/DSH：介质级坏 JSON = malformed-medium（非 backup 语义——
        // backupRecord 只处理"JSON 合法但 schema 不过"）
        throw new TdaError(
          'MALFORMED_MEDIUM',
          `sqlite 单元 '${this.mediumUnit}' 记录 ${row.key.slice(0, 40)} 持有不可解析 JSON`,
        );
      }
      map.set(composite, value);
    }
    return map;
  }

  putRecord(key: string, value: unknown): void {
    // key = `table\0recordKey`（domain 层 composite）；value 经 zod 校验的 plain object
    this.db
      .prepare(
        `INSERT INTO "${recordTableName(this.mediumUnit)}" (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(encodeComposite(key), JSON.stringify(value));
  }

  deleteRecord(key: string): void {
    this.db.prepare(`DELETE FROM "${recordTableName(this.mediumUnit)}" WHERE key = ?`).run(encodeComposite(key));
  }

  backupRecord(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO "${backupTableName(this.mediumUnit)}" (key, value, backedUpAt) VALUES (?, ?, ?)`,
      )
      .run(encodeComposite(key), JSON.stringify(value), Date.now());
  }

  close(): void {
    /* 单元无独立句柄——backend.close 统一关 db */
  }
}

/** SQLite backend（DSH 兼容物理布局；同步原语——node:sqlite 本身同步）。 */
export class SqliteCompatBackend implements TdaStorageBackend {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string, journalMode: 'wal' | 'delete' | 'truncate' | 'persist' = 'wal') {
    const actual = path === ':memory:' ? path : resolve(path);
    // （本类无参数属性——同可擦除纪律）
    if (actual !== ':memory:') {
      mkdirSync(dirname(actual), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(actual);
    // pragmas + 布局版（DDL 同构 vendor schema.ts；STRICT 表与 DSH 后端互通）
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`);
    const { user_version: onDisk } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (onDisk !== 0 && onDisk !== STORAGE_SQLITE_SCHEMA_VERSION) {
      this.db.close();
      throw new TdaError(
        'SCHEMA_VERSION_MISMATCH',
        `sqlite 存储布局版本 ${onDisk} 与本构建 ${STORAGE_SQLITE_SCHEMA_VERSION} 不符：${actual}`,
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS units (
        name    TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      ) STRICT
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS unit_globals (
        unit  TEXT PRIMARY KEY REFERENCES units(name),
        value TEXT NOT NULL
      ) STRICT
    `);
    if (onDisk === 0) {
      // 布局完整后再戳版（vendor schema.ts 同序：失败留未戳，重开重试）
      this.db.exec(`PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION}`);
    }
  }

  open(descriptor: TdaUnitDescriptor): TdaKvUnit {
    if (this.closed) {
      throw new TdaError('STORAGE_CLOSED', 'sqlite backend 已关闭');
    }
    const mediumUnit = toMediumUnitName(descriptor.name);
    if (!/^[a-z][a-z0-9_]*$/.test(mediumUnit)) {
      throw new TdaError('UNIT_NAME_INVALID', `介质单元名 '${mediumUnit}' 违反 DSH UNIT_NAME_RE`);
    }
    const row = this.db.prepare('SELECT version FROM units WHERE name = ?').get(mediumUnit) as
      | { version: number }
      | undefined;
    if (row === undefined) {
      this.db.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(mediumUnit, descriptor.version);
    } else if (row.version !== descriptor.version) {
      // 版本兼容集（TDA 语义）：旧版可开 ⇒ 重戳当前版；否则拒绝（jsonBackend 对偶）
      const compatible = descriptor.compatibleVersions ?? [];
      if (!compatible.includes(row.version)) {
        throw new TdaError(
          'VERSION_MISMATCH',
          `单元 '${descriptor.name}' 介质版本 ${row.version} 与 domain 版本 ${descriptor.version}（兼容 ${compatible.length > 0 ? compatible.join('/') : '无'}）不符`,
        );
      }
      this.db.prepare('UPDATE units SET version = ? WHERE name = ?').run(descriptor.version, mediumUnit);
    }
    // 主表 + 影子备份表（backup-and-skip 落点；主布局 DSH 可读）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${recordTableName(mediumUnit)}" (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${backupTableName(mediumUnit)}" (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        backedUpAt  INTEGER NOT NULL
      ) STRICT
    `);
    return new SqliteUnit(this.db, mediumUnit);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** P5.1 出口：与 createJsonBackend 同形的 sqlite backend 工厂（路径或 ':memory:'）。 */
export function createSqliteBackend(path: string): TdaStorageBackend {
  return new SqliteCompatBackend(path);
}

// 复合键助手重导出（测试与适配层共用；权威定义在 domain.ts）
export { RECORD_KEY_SEPARATOR };
