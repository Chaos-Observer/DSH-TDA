/**
 * tda-workspace 事件构造：只允许走已登记族（workspace/scan，编号 6）。
 *
 * 载荷 = ScanRun 全快照：replay 由载荷重建 `ws_scan_runs`（扫描历史的权威序列）。
 * 注意派生边界：file_nodes/edges/cache 是**派生视图**（同一次 scan 的窗口内一并落域，
 * 双写配对口径由此保证），它们不由事件回放重建，而由重扫重建（不变量 8）；
 * 这与"扫描历史 append-only"是两种数据的不同生命周期，刻意不混。
 */
import type { JsonObject } from '@tda/kernel';
import type { ScanRun } from './domain.ts';

export const workspaceScanPayload = (run: ScanRun): JsonObject => ({
  id: run.id,
  taskId: run.taskId,
  mode: run.mode,
  status: run.status,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  filesScanned: run.filesScanned,
  filesChanged: run.filesChanged,
  truncated: run.truncated,
  ...(run.unfinished !== undefined ? { unfinished: [...run.unfinished] } : {}),
  ...(run.inventoryEntryId !== undefined ? { inventoryEntryId: run.inventoryEntryId } : {}),
  ...(run.notesEntryId !== undefined ? { notesEntryId: run.notesEntryId } : {}),
  ...(run.childSessionId !== undefined ? { childSessionId: run.childSessionId } : {}),
  localPath: run.localPath,
  maxFiles: run.maxFiles,
  maxBytes: run.maxBytes,
});
