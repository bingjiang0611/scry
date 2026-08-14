// 统一 Diff 联动的唯一派生层：权威模型仍是每轮 harness/turn_diff 携带的 TurnDiffSnapshot，
// 这里只做选择与汇总，不引入第二套 diff 状态。运行中的 *_preview 快照来自同一条 Git capture，
// 优先级永远低于终态：终态一到就取代它，绝不出现「终态被预览覆盖」或数字倒退。
import {
  SESSION_DIFF_PREVIEW_STAGE,
  SESSION_DIFF_STAGE,
  TURN_DIFF_PREVIEW_STAGE,
  TURN_DIFF_STAGE,
  type DiffFile,
  type TraceEvent,
  type TurnDiffBaselineOrigin,
  type TurnDiffSnapshot
} from '@shared/trace'
import { basename, type Turn } from './format'

export interface TurnDiffReview {
  runId: string
  userText: string
  turnDiff: TurnDiffSnapshot
  initialPath?: string
  /** 'turn' = 单轮 diff；'session' = 会话净 diff（第一轮前基线 → 当前）。缺省按单轮处理。 */
  scope?: 'turn' | 'session'
  /** true = 运行中的临时 Git 快照，本轮还没结束；UI 必须标出来。 */
  preview?: boolean
}

/** 一个 scope 当前该展示的快照，以及它是不是运行中的临时快照。 */
export interface TurnDiffView {
  turnDiff: TurnDiffSnapshot
  preview: boolean
}

export interface SessionDiffFile {
  path: string
  added: number
  deleted: number
  /** 该文件出现在多少个已捕获轮次里 */
  turns: number
  binary: boolean
}

export interface SessionDiffSummary {
  files: SessionDiffFile[]
  /** 各轮 +/− 的累计活动量：同一行跨轮反复改会重复计入，不是工作树净改动 */
  added: number
  deleted: number
  /** 参与汇总的已捕获轮次数 */
  turnCount: number
}

export function displayDiffPath(path: string, repoRoot?: string): string {
  const normalized = path.replace(/\\/g, '/')
  const root = repoRoot?.replace(/\\/g, '/').replace(/\/$/, '')
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1)
  return basename(path)
}

function lastSnapshotAtStage(items: readonly TraceEvent[], stage: string): TurnDiffSnapshot | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const event = items[index]
    if (event.kind === 'harness' && event.stage === stage) return event.turnDiff
  }
  return undefined
}

export function turnDiffOf(items: readonly TraceEvent[]): TurnDiffSnapshot | undefined {
  return lastSnapshotAtStage(items, TURN_DIFF_STAGE)
}

function reviewable(turnDiff: TurnDiffSnapshot | undefined): turnDiff is TurnDiffSnapshot {
  return turnDiff?.status === 'captured' && turnDiff.files.length > 0
}

/** 终态优先、运行中预览兜底。缺省不返回不可审阅的快照以外的东西，判定留给调用方。 */
function viewOf(
  items: readonly TraceEvent[],
  finalStage: string,
  previewStage: string
): TurnDiffView | undefined {
  const settled = lastSnapshotAtStage(items, finalStage)
  if (settled) return { turnDiff: settled, preview: false }
  const preview = lastSnapshotAtStage(items, previewStage)
  return preview ? { turnDiff: preview, preview: true } : undefined
}

export function turnDiffViewOf(items: readonly TraceEvent[]): TurnDiffView | undefined {
  return viewOf(items, TURN_DIFF_STAGE, TURN_DIFF_PREVIEW_STAGE)
}

export function sessionDiffViewOf(items: readonly TraceEvent[]): TurnDiffView | undefined {
  return viewOf(items, SESSION_DIFF_STAGE, SESSION_DIFF_PREVIEW_STAGE)
}

/**
 * 顶栏 Diff 直接打开、Overview 会话改动点击共用的入口解析：从最近一轮往前找第一个
 * 可审阅的 captured 快照；给了 path 就要求该轮真的包含这个文件，避免定位到错误轮次。
 * 运行中的轮次只有预览快照时也照样能打开，但会带上 preview 标记。
 */
export function resolveTurnDiffReview(turns: readonly Turn[], path?: string, runId?: string): TurnDiffReview | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (runId && turn.runId !== runId) continue
    const view = turnDiffViewOf(turn.items)
    if (!view || !reviewable(view.turnDiff)) continue
    if (path && !view.turnDiff.files.some((file) => file.path === path)) continue
    return {
      runId: turn.runId,
      userText: turn.userText,
      turnDiff: view.turnDiff,
      ...(view.preview ? { preview: true } : {}),
      ...(path ? { initialPath: path } : {})
    }
  }
  return null
}

export function sessionDiffOf(items: readonly TraceEvent[]): TurnDiffSnapshot | undefined {
  return lastSnapshotAtStage(items, SESSION_DIFF_STAGE)
}

/**
 * 会话净 diff 的选取：从最近一轮往前找第一条「带有会话快照事件」的轮次并停下。
 * 只跳过完全没有会话快照的轮次（运行中还没落终态、或旧会话没这功能）——一旦某轮带了快照，
 * 哪怕是空/超时/失败，它对那个时间点就是权威的，绝不越过它去复活更早的过期净 diff。
 * 停下的那条快照是否可审阅，交给调用方按 reviewable 判定。
 */
function sessionDiffViewFromTurns(turns: readonly Turn[]): { turn: Turn; view: TurnDiffView } | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    const view = sessionDiffViewOf(turn.items)
    if (view) return reviewable(view.turnDiff) ? { turn, view } : null
  }
  return null
}

/**
 * 右栏「会话净改动」的权威入口：main 用贯穿会话的 baseline 算出的「基线 → 当前」真实净 diff。
 * 给了 path 就要求该文件真的在净 diff 里，保证按文件定位落到正确视图。
 */
export function sessionNetDiffReview(turns: readonly Turn[], path?: string): TurnDiffReview | null {
  const found = sessionDiffViewFromTurns(turns)
  if (!found) return null
  if (path && !found.view.turnDiff.files.some((file) => file.path === path)) return null
  return {
    runId: found.turn.runId,
    userText: found.turn.userText,
    turnDiff: found.view.turnDiff,
    scope: 'session',
    ...(found.view.preview ? { preview: true } : {}),
    ...(path ? { initialPath: path } : {})
  }
}

export interface SessionNetDiffSummary {
  files: DiffFile[]
  added: number
  deleted: number
  /** true = 运行中的临时快照 */
  preview: boolean
  /** 基线是会话首轮前还是恢复后重锚；缺省表示这条快照没带来源标注。 */
  baseline?: TurnDiffBaselineOrigin
}

/**
 * 会话结束摘要用的真实净改动：直接取最近一条可审阅会话快照本身的每文件净增删，
 * 不做逐轮累计（同一行跨轮反复改在快照里已净算一次）。没有可审阅快照就返回 null，不编空摘要。
 */
export function sessionNetDiffSummary(turns: readonly Turn[]): SessionNetDiffSummary | null {
  const found = sessionDiffViewFromTurns(turns)
  if (!found) return null
  const { turnDiff } = found.view
  return {
    files: turnDiff.files,
    added: turnDiff.files.reduce((sum, file) => sum + file.added, 0),
    deleted: turnDiff.files.reduce((sum, file) => sum + file.deleted, 0),
    preview: found.view.preview,
    ...(turnDiff.baseline ? { baseline: turnDiff.baseline } : {})
  }
}

export function sessionDiffSummary(turns: readonly Turn[]): SessionDiffSummary {
  const byPath = new Map<string, SessionDiffFile>()
  let added = 0
  let deleted = 0
  let turnCount = 0
  for (const turn of turns) {
    const turnDiff = turnDiffOf(turn.items)
    if (!reviewable(turnDiff)) continue
    turnCount += 1
    for (const file of turnDiff.files) {
      const row = byPath.get(file.path) ?? { path: file.path, added: 0, deleted: 0, turns: 0, binary: false }
      row.added += file.added
      row.deleted += file.deleted
      row.turns += 1
      row.binary = row.binary || file.binary === true
      byPath.set(file.path, row)
      added += file.added
      deleted += file.deleted
    }
  }
  const files = [...byPath.values()].sort(
    (a, b) => b.added + b.deleted - (a.added + a.deleted) || a.path.localeCompare(b.path)
  )
  return { files, added, deleted, turnCount }
}

// 末尾换行只是结束最后一行，不新开一行；空串代表「没有被替换/插入的行」。
function countEditLines(text: string): number {
  if (!text) return 0
  let lines = 1
  for (const char of text) if (char === '\n') lines += 1
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * 单次 Edit 工具输入的 action-level 行数：被替换掉的 old_string 行数与写入的 new_string 行数。
 * 这不是 Git 净改动——同一行改两次会算两次，也不反映其他工具对同文件的影响。
 */
export function editActionLineCounts(input: unknown): { added: number; deleted: number } | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const oldString = typeof record.old_string === 'string' ? record.old_string : null
  const newString = typeof record.new_string === 'string' ? record.new_string : null
  if (oldString == null && newString == null) return null
  return { added: countEditLines(newString ?? ''), deleted: countEditLines(oldString ?? '') }
}
