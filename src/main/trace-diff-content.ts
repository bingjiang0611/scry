// 累积会话 diff 快照每轮都重写同一份文件清单与 patch 正文，是大会话 archive 体积的主因
// （用户真实会话 407 MB / 40 轮里 369 MB 是同一份快照的两份拷贝）。这里把 patch 正文写入
// 内容寻址的 trace-content 库，turn 文件只留引用与一段有界预览：证据不删，重复字节去重。
//
// 只有 session 级快照（`session_diff` / `session_diff_preview`）与从不展示的
// `turnEvidence.diff` 走引用；单轮 `turn_diff` 仍保持 inline，因为历史页会按轮展示它。
// 读取端在页面组装时把**页面内最新一条** session 快照的正文取回，渲染层无需改动。
import { SESSION_DIFF_PREVIEW_STAGE, SESSION_DIFF_STAGE, type DiffFile } from '../shared/turn-diff'
import type { ToolContent } from '../shared/tool-content'
import type { TraceEvent } from '../shared/trace'
import { readRecorderContent, writeRecorderContent } from '../core/turn-recorder/content-store'
import { APP_TRACE_CONTENT_SOURCE, appTraceContentRoot } from './trace-tool-content'
import type { TraceArchiveTurn } from './transcript-archive'

// 小 diff 的引用收益不抵一次额外读盘，保持 inline。
const REFERENCE_THRESHOLD_BYTES = 4 * 1024
const PREVIEW_BYTES = 2 * 1024

function isSessionSnapshotStage(stage: string): boolean {
  return stage === SESSION_DIFF_STAGE || stage === SESSION_DIFF_PREVIEW_STAGE
}

/** 终态 TurnDiffSnapshot 与 canonical TurnDiffSnapshotRecord 都只靠文件清单承载 patch 正文。 */
interface PatchBearingSnapshot {
  files: DiffFile[]
}

function needsReference(file: DiffFile): boolean {
  return typeof file.patch === 'string' &&
    file.patch.length >= REFERENCE_THRESHOLD_BYTES &&
    !file.patchContent?.contentRef
}

async function externalizeSnapshot(
  root: string,
  snapshot: PatchBearingSnapshot | undefined
): Promise<boolean> {
  if (!snapshot || !Array.isArray(snapshot.files)) return false
  let changed = false
  // 逐个 publish：内容库按 sha256 去重，同一个 patch 在后面的轮次里只多做一次校验，不重复落盘。
  for (const file of snapshot.files) {
    if (!needsReference(file)) continue
    const patch = file.patch!
    const ref = await writeRecorderContent(root, patch, 'utf8')
    const preview = patch.slice(0, PREVIEW_BYTES)
    // savedBytes 是 inline 预览的字节数（ToolContent 合同），完整正文只在 contentRef 里。
    const patchContent: ToolContent = {
      content: preview,
      contentRef: ref,
      encoding: 'utf8',
      savedBytes: Buffer.byteLength(preview, 'utf8'),
      source: APP_TRACE_CONTENT_SOURCE,
      sourceCompleteness: 'complete',
      redaction: 'not_run',
      storage: 'complete',
      reasons: []
    }
    file.patchContent = patchContent
    delete file.patch
    changed = true
  }
  return changed
}

/**
 * 把一轮里 session 级 diff 快照与 turnEvidence diff 的 patch 正文转成内容引用。
 * `turn_diff` 保持 inline：历史页会按轮展示它，换引用会让既有 UI 失去正文。
 */
export async function externalizeTraceDiffPatches(
  userDataDir: string,
  cwd: string,
  turn: TraceArchiveTurn
): Promise<{ turn: TraceArchiveTurn; changed: boolean }> {
  const root = appTraceContentRoot(userDataDir, cwd)
  let changed = false
  for (const item of turn.items) {
    if (isSessionSnapshotStage(item.stage)) {
      changed = await externalizeSnapshot(root, item.turnDiff) || changed
    }
  }
  // Canonical evidence 从不进入渲染页，两份快照都可以只留引用。
  const evidenceDiffs = turn.turnEvidence?.diff.value
  if (Array.isArray(evidenceDiffs)) {
    for (const snapshot of evidenceDiffs) {
      changed = await externalizeSnapshot(root, snapshot) || changed
    }
  }
  return { turn, changed }
}

/** 取回一条快照的 patch 正文；引用缺失或损坏时保留引用本身，不伪造空白 patch。 */
async function hydrateSnapshot(root: string, snapshot: PatchBearingSnapshot | undefined): Promise<void> {
  if (!snapshot || !Array.isArray(snapshot.files)) return
  for (const file of snapshot.files) {
    const ref = file.patchContent?.contentRef
    if (file.patch !== undefined || !ref) continue
    file.patch = await readRecorderContent(root, ref)
  }
}

/**
 * 页面组装后把**页面内最新一条**终态/预览 session 快照的正文取回，
 * 其余轮次的累积快照不出现在跨 IPC 的页里，因此不必读回。
 */
export async function hydrateNewestSessionSnapshots(
  userDataDir: string,
  cwd: string,
  turns: readonly TraceArchiveTurn[]
): Promise<void> {
  const root = appTraceContentRoot(userDataDir, cwd)
  const hydrated = new Set<string>()
  for (let index = turns.length - 1; index >= 0 && hydrated.size < 2; index--) {
    for (let itemIndex = turns[index].items.length - 1; itemIndex >= 0 && hydrated.size < 2; itemIndex--) {
      const item: TraceEvent = turns[index].items[itemIndex]
      if (!isSessionSnapshotStage(item.stage) || hydrated.has(item.stage)) continue
      hydrated.add(item.stage)
      await hydrateSnapshot(root, item.turnDiff)
    }
  }
}
