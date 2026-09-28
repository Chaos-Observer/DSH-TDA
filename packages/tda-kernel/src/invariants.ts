/**
 * 不变量注册：镜像 DSH ctx.invariants 契约（docs/subsystems/invariants.md）。
 *
 *  - 注册名 = 确切 npm 包名；内核级检查注册于 @tda/kernel
 *  - installer 收到 (ctx, fail)；fail(message) 抛 InvariantError
 *  - 重复注册 / 空白包名直接抛（fail-loud）
 */
import { TdaError } from './types.ts';
import type { DualWriteReconciler } from './dualWrite.ts';

/** 内核 npm 包名：内核级不变量以其注册（承 DSH"注册名=确切包名"约定）。 */
export const TDA_KERNEL_PACKAGE = '@tda/kernel';

export type InvariantFailure = (message: string) => never;

export interface TdaInvariantCheck {
  readonly name: string;
  run(fail: InvariantFailure): void | Promise<void>;
}

export interface TdaInvariantContext {
  readonly packageName: string;
}

export type TdaInvariantInstaller = (
  ctx: TdaInvariantContext,
  fail: InvariantFailure,
) => void | Promise<void>;

export interface TdaInvariantRegistry {
  register(packageName: string, installer: TdaInvariantInstaller): () => void;
  /** 运行指定包（缺省全部）的检查；首个失败即抛 InvariantError。 */
  verify(packageName?: string): Promise<void>;
}

export class InvariantError extends TdaError {
  // 显式字段声明（不用参数属性）：保持 erasable-syntax-only，Node strip-only 可直跑。
  readonly packageName: string;

  constructor(
    packageName: string,
    message: string,
  ) {
    super('INVARIANT', `invariant violated by "${packageName}": ${message}`);
    this.packageName = packageName;
  }
}

/** 内核级检查：双写配对（漏双写/反向洞/失败窗口任一非零即违规）。 */
export function kernelInvariantChecks(reconciler: DualWriteReconciler): TdaInvariantCheck[] {
  return [
    {
      name: 'dualwrite-pairing',
      run(fail) {
        const report = reconciler.reconcile();
        if (!report.ok) {
          fail(
            `双写配对失败：漏双写 ${report.unpairedChanges.length} 处、` +
              `反向洞 ${report.unmatchedWrites} 次、失败窗口 ${report.failedWindows} 次`,
          );
        }
      },
    },
    // round↔turn 一致性检查留待 IT4 session seam 落地
  ];
}

/**
 * registry → 该 registry 上的内核级检查登记（对账器 + 包名注销器）。
 *
 * 多个插件各自持有对账器（对账器随 `DualWriteContext` 注入，故天然分片），
 * 但"注册名 = 确切包名"要求 @tda/kernel 在**同一 registry 上只注册一次**。
 * 于是 installer 覆盖该 registry 上的全部对账器：任一插件漏双写都逃不过内核门。
 * 用 WeakMap 而非模块级单例：registry 生命周期独立（测试各自建 registry 互不串扰）。
 */
interface KernelCheckBundle {
  readonly reconcilers: DualWriteReconciler[];
  /** 该 registry 上 @tda/kernel 包名注册的注销器（末位对账器退订时调用）。 */
  unregister: () => void;
}

const kernelBundles = new WeakMap<TdaInvariantRegistry, KernelCheckBundle>();

function createKernelBundle(registry: TdaInvariantRegistry): KernelCheckBundle {
  const bundle: KernelCheckBundle = { reconcilers: [], unregister: () => {} };
  bundle.unregister = registry.register(TDA_KERNEL_PACKAGE, async (_ctx, fail) => {
    for (const one of bundle.reconcilers) {
      for (const check of kernelInvariantChecks(one)) {
        await check.run(fail);
      }
    }
  });
  return bundle;
}

/**
 * 把内核级检查注册到 registry（注册名 @tda/kernel）。
 *
 * 可重入：同一 registry 重复调用只累加对账器，不重复注册包名；
 * 返回的退订只摘除本次传入的对账器，末位摘除时整体注销包名注册
 * （此后可重新干净注册，供 registry 复用场景）。
 */
export function registerTdaInvariants(
  registry: TdaInvariantRegistry,
  reconciler: DualWriteReconciler,
): () => void {
  const existing = kernelBundles.get(registry);
  const bundle = existing ?? createKernelBundle(registry);
  if (existing === undefined) kernelBundles.set(registry, bundle);
  bundle.reconcilers.push(reconciler);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = bundle.reconcilers.indexOf(reconciler);
    if (index >= 0) bundle.reconcilers.splice(index, 1);
    if (bundle.reconcilers.length === 0) {
      kernelBundles.delete(registry);
      bundle.unregister();
    }
  };
}

/** 插件侧助手：把插件级检查打包成 installer（插件在 loadChecks 里用自己的包名注册）。 */
export function tdaPluginInstaller(checks: readonly TdaInvariantCheck[]): TdaInvariantInstaller {
  return async (_ctx, fail) => {
    for (const check of checks) {
      await check.run(fail);
    }
  };
}

/** 内存参考实现：IT1 起由 DSH ctx.invariants 适配替换。 */
export function createTdaInvariantRegistry(): TdaInvariantRegistry {
  const installers = new Map<string, TdaInvariantInstaller>();
  return {
    register(packageName, installer) {
      const name = packageName.trim();
      if (!name) {
        throw new TdaError('INVALID_INVARIANT_PACKAGE', '不变量注册包名不得为空白');
      }
      if (installers.has(name)) {
        throw new TdaError('DUPLICATE_INVARIANT_PACKAGE', `包 "${name}" 重复注册不变量（一名一注册）`);
      }
      installers.set(name, installer);
      return () => {
        installers.delete(name);
      };
    },
    async verify(packageName) {
      for (const [name, installer] of installers) {
        if (packageName !== undefined && name !== packageName) continue;
        const fail: InvariantFailure = (message) => {
          throw new InvariantError(name, message);
        };
        await installer({ packageName: name }, fail);
      }
    },
  };
}
