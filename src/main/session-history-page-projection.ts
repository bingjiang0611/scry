import type { TraceEvent } from '../shared/trace'
import { SESSION_DIFF_PREVIEW_STAGE, SESSION_DIFF_STAGE } from '../shared/turn-diff'
import type { SessionHistoryPage } from './session-history'
import type { TraceArchive, TraceArchiveTurn } from './transcript-archive'

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
