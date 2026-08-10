// 统一 Diff 联动的唯一派生层：权威模型仍是每轮 harness/turn_diff 携带的 TurnDiffSnapshot，
// 这里只做选择与汇总，不引入第二套 diff 状态。
import type { TraceEvent, TurnDiffSnapshot } from '@shared/trace'
import { basename, type Turn } from './format'

export interface TurnDiffReview {
  runId: string
  userText: string
  turnDiff: TurnDiffSnapshot
  initialPath?: string
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

export function turnDiffOf(items: readonly TraceEvent[]): TurnDiffSnapshot | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const event = items[index]
    if (event.kind === 'harness' && event.stage === 'turn_diff') return event.turnDiff
  }
  return undefined
}

function reviewable(turnDiff: TurnDiffSnapshot | undefined): turnDiff is TurnDiffSnapshot {
  return turnDiff?.status === 'captured' && turnDiff.files.length > 0
}

/**
 * 顶栏 Diff 直接打开、Overview 会话改动点击共用的入口解析：从最近一轮往前找第一个
 * 可审阅的 captured 快照；给了 path 就要求该轮真的包含这个文件，避免定位到错误轮次。
 */
export function resolveTurnDiffReview(turns: readonly Turn[], path?: string, runId?: string): TurnDiffReview | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (runId && turn.runId !== runId) continue
    const turnDiff = turnDiffOf(turn.items)
    if (!reviewable(turnDiff)) continue
    if (path && !turnDiff.files.some((file) => file.path === path)) continue
    return {
      runId: turn.runId,
      userText: turn.userText,
      turnDiff,
      ...(path ? { initialPath: path } : {})
    }
  }
  return null
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
