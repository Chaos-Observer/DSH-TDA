/**
 * 参考 JSON backend：镜像 dsh-storage-json 的原子整文件发布语义。
 *
 *  - 读：解析失败抛 MALFORMED_MEDIUM；文件版本与 domain 版本不符抛 VERSION_MISMATCH
 *  - 写：内存缓存为权威 → 整文件发布（tmp 写入 + fsync + rename）
 *  - backupRecord：损坏记录追加进 <name>.backup.json（backup-and-skip 移出主存储）
 *
 * IT0 自包含参考实现；IT1 起由 DSH 真实 backend adapter 经内核单点替换。
 */
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TdaError } from './types.ts';
import type { TdaKvUnit, TdaStorageBackend, TdaUnitDescriptor } from './domain.ts';

interface JsonUnitFile {
  readonly version: number;
  readonly records: Record<string, unknown>;
}

class JsonUnit implements TdaKvUnit {
  private cache: Map<string, unknown> | null = null;
  private readonly root: string;
  private readonly descriptor: TdaUnitDescriptor;
  /** flush 串行链：`.tmp` 是单一共享路径，并发发布必须排队（见 flush 注释）。 */
  private publishChain: Promise<void> = Promise.resolve();
  /** 首次装载单飞：并发首写不得各得一份新 Map（见 ensureCache 注释）。 */
  private firstLoad: Promise<Map<string, unknown>> | null = null;

  // 显式字段声明（不用参数属性）：保持源码 erasable-syntax-only。
  constructor(root: string, descriptor: TdaUnitDescriptor) {
    this.root = root;
    this.descriptor = descriptor;
  }

  private get mainFile(): string {
    return join(this.root, `${this.descriptor.name}.json`);
  }

  private get tmpFile(): string {
    return `${this.mainFile}.tmp`;
  }

  private get backupFile(): string {
    return join(this.root, `${this.descriptor.name}.backup.json`);
  }

  /**
   * 读整文件为权威缓存并返回副本（对外副本：调用方改不到内部缓存）。
   *
   * 并发安全由 ensureCache 的单飞保证：本方法不自赋 `this.cache`，
   * 否则并发首载会各得一份新 Map（见 ensureCache 注释）。
   */
  async loadAll(): Promise<Map<string, unknown>> {
    const authoritative = await this.ensureCache();
    return new Map(authoritative);
  }

  /** 从磁盘读取（只由 ensureCache 单飞调用）。 */
  private async readFromDisk(): Promise<Map<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(this.mainFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map(); // 首次落盘前：空库
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TdaError('MALFORMED_MEDIUM', `存储文件解析失败：${this.mainFile}`);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as JsonUnitFile).version !== 'number' ||
      typeof (parsed as JsonUnitFile).records !== 'object' ||
      (parsed as JsonUnitFile).records === null
    ) {
      throw new TdaError('MALFORMED_MEDIUM', `存储文件结构不完整：${this.mainFile}`);
    }
    const file = parsed as JsonUnitFile;
    if (file.version !== this.descriptor.version) {
      throw new TdaError(
        'VERSION_MISMATCH',
        `存储文件版本 ${file.version} 与 domain 版本 ${this.descriptor.version} 不符：${this.mainFile}`,
      );
    }
    return new Map(Object.entries(file.records));
  }

  /**
   * 取权威缓存（首次调用触发单飞装载）。
   *
   * 必须单飞：`if (cache) return cache; await load()` 的写法是 check-then-act——
   * 并发首写各自走一遍装载并各自 `new Map()`，后写覆盖 `this.cache`，
   * 先写落在孤儿 Map 上 → **静默丢更新**（表现为落盘只剩一条记录）。
   * 故缓存装载 promise：并发调用者共用同一 Map 实例。
   * 失败不缓存 promise（修正介质后可重试；MALFORMED_MEDIUM 的 fail-loud 语义不变）。
   */
  private async ensureCache(): Promise<Map<string, unknown>> {
    if (this.cache !== null) return this.cache;
    this.firstLoad ??= this.readFromDisk();
    let loaded: Map<string, unknown>;
    try {
      loaded = await this.firstLoad;
    } catch (error) {
      this.firstLoad = null;
      throw error;
    }
    this.cache = loaded;
    return loaded;
  }

  /**
   * 整文件原子发布：tmp 写入 + fsync + rename。
   *
   * **必须串行**：`.tmp` 是同一 unit 的单一共享路径，两次发布交错会互相踩踏
   * （Windows 上第二次 open 得 EPERM；POSIX 上更隐蔽——一个 rename 可能搬走
   * 另一个尚未写满的 tmp，得到半份文件）。故所有发布排进一条链。
   * 链上单次失败不吞：调用方收到本次的 rejection；链本体吸收后继续排队。
   */
  private async flush(): Promise<void> {
    if (!this.cache) return;
    const publish = this.publishChain.then(() => this.publish());
    this.publishChain = publish.then(
      () => undefined,
      () => undefined,
    );
    return publish;
  }

  private async publish(): Promise<void> {
    if (!this.cache) return;
    await mkdir(this.root, { recursive: true });
    const payload: JsonUnitFile = {
      version: this.descriptor.version,
      records: Object.fromEntries(this.cache),
    };
    await writeFile(this.tmpFile, JSON.stringify(payload), 'utf8');
    const handle = await open(this.tmpFile, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(this.tmpFile, this.mainFile);
  }

  async putRecord(key: string, value: unknown): Promise<void> {
    const cache = await this.ensureCache();
    cache.set(key, value);
    await this.flush();
  }

  async deleteRecord(key: string): Promise<void> {
    const cache = await this.ensureCache();
    cache.delete(key);
    await this.flush();
  }

  async backupRecord(key: string, value: unknown): Promise<void> {
    let backup: Record<string, unknown> = {};
    try {
      const raw = await readFile(this.backupFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        backup = parsed as Record<string, unknown>;
      }
    } catch {
      backup = {};
    }
    backup[key] = value;
    await mkdir(this.root, { recursive: true });
    await writeFile(this.backupFile, JSON.stringify(backup), 'utf8');
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

export function createJsonBackend(root: string): TdaStorageBackend {
  const units = new Map<string, JsonUnit>();
  return {
    open(descriptor: TdaUnitDescriptor): TdaKvUnit {
      let unit = units.get(descriptor.name);
      if (!unit) {
        unit = new JsonUnit(root, descriptor);
        units.set(descriptor.name, unit);
      }
      return unit;
    },
    async close(): Promise<void> {
      for (const unit of units.values()) {
        await unit.close();
      }
      units.clear();
    },
  };
}
