/**
 * tda-recall 插件级不变量：以插件自己的 npm 包名注册（`tda-recall`）。
 *
 * T1.1 §4.1 七条不变量 → 检查/运行时/结构分层映射：
 *  1. gate 先行               → **结构性**（`evaluateAll` 里 gate 未过即 continue，不进计分）
 *                               + 加载期 `recall-gate-consistency`（injected ⇒ gatePassed）；
 *  2. 低凭证双条件            → **结构性**（`evaluateGate` 唯一判定点）+ 冒烟门四象限用例；
 *  3. 预算纪律                → 服务期（`selectForInjection` 累计 token 帽）；
 *  4. 低分不注入              → **结构性**（`injectCandidates` 不接受 `includeBelowMin`）；
 *  5. 复用留痕                → **结构性**（管线唯一出口 `writeLogs`；无"召回但不记日志"的路径）
 *                               + 加载期 `recall-log-completeness`；
 *  6. 衰减单调                → **结构性**（`recencyScore` 的 `0.5 ** (age/H)` 公式级单调）
 *                               + 不变量门用例；
 *  7. 参数可审计              → 加载期 `recall-params-singleton` + `recall-log-params-revision`。
 *
 * 加载期能查的只有本域两表（recall_params / recall_log）——时间线与焦点都在别的插件，
 * 跨插件一致性由装配层集成门承担。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import {
  RECALL_PARAMS_KEY,
  RecallParamsSchema,
  type RecallLogRecord,
  type RecallParams,
  type RecallTables,
} from './domain.ts';

export function recallInvariantChecks(domain: TdaDomain<RecallTables>): TdaInvariantCheck[] {
  return [
    {
      name: 'recall-params-singleton',
      run(fail) {
        const table = domain.table('recall_params');
        const rows = [...table.keys()];
        if (rows.length !== 1) {
          fail(`recall_params 必须恰有一行（收到 ${rows.length}）——参数权威是单行，多行即无从裁决`);
        }
        if (rows[0] !== RECALL_PARAMS_KEY) {
          fail(`recall_params 行键必须是 ${RECALL_PARAMS_KEY}，实为 ${String(rows[0])}`);
        }
        const params = table.get(RECALL_PARAMS_KEY);
        if (params === undefined) {
          fail('recall_params 单行缺失（启动序 initialize 未跑？）');
          return;
        }
        const parsed = RecallParamsSchema.safeParse(params);
        if (!parsed.success) {
          fail(`recall_params 非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`);
        }
      },
    },
    {
      name: 'recall-log-gate-consistency',
      run(fail) {
        const table = domain.table('recall_log');
        for (const [key, row] of table.entries() as IterableIterator<[string, RecallLogRecord]>) {
          // 不变量 1/4：被 gate 拦下不得进注入集，也不得带分（否则等于"先打分再拦截"）
          if (!row.gatePassed && row.injected) {
            fail(`日志 ${key}（entry=${row.entryId}）gatePassed=false 却 injected=true（闸门后可回填？）`);
          }
          if (!row.gatePassed && row.score !== 0) {
            fail(`日志 ${key}（entry=${row.entryId}）gatePassed=false 却带分 ${row.score}（gate 必须先于计分）`);
          }
          if (!row.gatePassed && row.reason === undefined) {
            fail(`日志 ${key}（entry=${row.entryId}）被拦下却无 reason——J5 要求闸门可解释`);
          }
        }
      },
    },
    {
      name: 'recall-log-params-revision',
      run(fail) {
        const params = domain.table('recall_params').get(RECALL_PARAMS_KEY) as RecallParams | undefined;
        const revision = params?.revision ?? 0;
        const table = domain.table('recall_log');
        for (const [key, row] of table.entries() as IterableIterator<[string, RecallLogRecord]>) {
          // 不变量 7：日志行必须自证它是在哪一版参数下产出的，且不得来自"未来"的版本
          if (row.paramsRevision > revision) {
            fail(`日志 ${key} 的 paramsRevision=${row.paramsRevision} 超前当前参数版本 ${revision}（回放解释不成立）`);
          }
        }
      },
    },
    {
      name: 'recall-log-key-canonical',
      run(fail) {
        const table = domain.table('recall_log');
        const seen = new Set<string>();
        for (const [key, row] of table.entries() as IterableIterator<[string, RecallLogRecord]>) {
          if (key !== row.id) {
            fail(`日志记录键 ${key} 与内容 id ${row.id} 不符（键即纪律）`);
          }
          if (seen.has(row.id)) {
            fail(`日志 id ${row.id} 重复——allocateId 无洞分配被绕过`);
          }
          seen.add(row.id);
        }
      },
    },
  ];
}

export function registerRecallInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<RecallTables>,
): () => void {
  return registry.register('tda-recall', tdaPluginInstaller(recallInvariantChecks(domain)));
}
