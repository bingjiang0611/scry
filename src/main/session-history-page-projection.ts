// 历史页投影：只裁剪要跨 IPC 的页，不改磁盘 archive、不改 main 侧 cache。
// 打开大会话的成本来自「每轮重复写同一份累积快照」与「同一批 turn 文件被解析两遍」，
// 这两个投影把重复工作去掉，而不是把证据搬走。
import type { TraceEvent } from '../shared/trace'
import { SESSION_DIFF_PREVIEW_STAGE, SESSION_DIFF_STAGE } from '../shared/turn-diff'
import type { SessionHistoryPage } from './session-history'
import type { TraceArchive, TraceArchiveTurn } from './transcript-archive'

/**
 * 原生历史对账要取的轮次里，已由当前 archive 页解析过的部分直接复用，只把未覆盖的 runId 交回给调用方去读盘。
 * 只接受未做 Profile 过滤的页：该过滤会丢弃不属于当前 Profile 的轮次，复用会变成静默缺轮。
 */
export function selectArchivePageTurns(
  pageArchive: TraceArchive | null,
  runIds: readonly string[]
): { turns: TraceArchiveTurn[]; missingRunIds: string[] } {
  if (!pageArchive) return { turns: [], missingRunIds: [...runIds] }
  const byRunId = new Map(pageArchive.turns.map((turn) => [turn.runId, turn]))
  const turns: TraceArchiveTurn[] = []
  const missingRunIds: string[] = []
  for (const runId of runIds) {
    const turn = byRunId.get(runId)
    if (turn) turns.push(turn)
    else missingRunIds.push(runId)
  }
  return { turns, missingRunIds }
}

export async function readSelectedArchivePageTurns(
  pageArchive: TraceArchive | null,
  runIds: readonly string[],
  readMissing: (runIds: readonly string[]) => Promise<TraceArchiveTurn[]>
): Promise<TraceArchiveTurn[]> {
  const { turns, missingRunIds } = selectArchivePageTurns(pageArchive, runIds)
  if (missingRunIds.length === 0) return turns
  const loaded = await readMissing(missingRunIds)
  const byRunId = new Map([...turns, ...loaded].map((turn) => [turn.runId, turn]))
  return runIds.flatMap((runId) => {
    const turn = byRunId.get(runId)
    return turn ? [turn] : []
  })
}

/**
 * 会话净 diff 快照是「会话开始 → 当前」的累积快照，每轮都重写同一份文件清单与 patch。
 * renderer 只读页面内最新的一条（`sessionDiffViewFromTurns` 从末尾往前找，找到就停），
 * 更早的累积快照在既有 UI 上永远不会被显示，却占历史页 80% 以上的 IPC 体积。
 * 这里只裁剪要跨 IPC 的投影：磁盘 archive 与 main 侧 sessionHistoryCache 保留全部快照，
 * 不删除任何证据，也不改变「最新快照即使是空/失败也仍然权威」的选取语义。
 */
export function projectHistoryPageSnapshots(page: SessionHistoryPage): SessionHistoryPage {
  const kept = new Set<string>()
  const turns = [...page.turns]
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    let changed = false
    const items: TraceEvent[] = []
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex--) {
      const event = turn.items[itemIndex]
      if (event.stage === SESSION_DIFF_STAGE || event.stage === SESSION_DIFF_PREVIEW_STAGE) {
        if (kept.has(event.stage)) {
          changed = true
          continue
        }
        kept.add(event.stage)
      }
      items.push(event)
    }
    if (changed) turns[index] = { ...turn, items: items.reverse() }
  }
  return { ...page, turns }
}
