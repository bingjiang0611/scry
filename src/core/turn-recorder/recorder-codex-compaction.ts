import type { TraceEvent } from '../../shared/trace.js'
import { nestedRecord, type ParsedTranscriptTurn } from './recorder-contracts.js'
import { stableHash } from './store.js'

export type CodexCompactionSource =
  | 'codex_rollout_context_compacted'
  | 'codex_rollout_compacted'
  | 'codex_rollout_compaction_item'
  | 'codex_rollout_item_completed_context_compaction'

export interface CodexCompactionMarker {
  at: string
  source: CodexCompactionSource
}

export const CODEX_COMPACTION_PAIR_WINDOW_MS = 5_000

export function codexCompactionMarker(
  type: string | undefined,
  payload: Record<string, unknown>,
  at: string
): CodexCompactionMarker | undefined {
  if (type === 'compacted') return { at, source: 'codex_rollout_compacted' }
  if (type === 'event_msg' && payload.type === 'context_compacted') return { at, source: 'codex_rollout_context_compacted' }
  if (type === 'response_item' && payload.type === 'compaction') return { at, source: 'codex_rollout_compaction_item' }
  if (type === 'event_msg' && payload.type === 'item_completed' && nestedRecord(payload, 'item')?.type === 'ContextCompaction') {
    return { at, source: 'codex_rollout_item_completed_context_compaction' }
  }
  return undefined
}

export function attachCodexCompactions(
  turns: ParsedTranscriptTurn[],
  markers: readonly CodexCompactionMarker[],
  runId: string
): void {
  if (markers.length === 0) return
  const ordered = [...markers].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const pairs: CodexCompactionMarker[][] = []
  for (const marker of ordered) {
    const open = pairs.at(-1)
    if (open && Date.parse(marker.at) - Date.parse(open[0].at) <= CODEX_COMPACTION_PAIR_WINDOW_MS) {
      open.push(marker)
    } else {
      pairs.push([marker])
    }
  }
  for (const [marker] of pairs) {
    const time = Date.parse(marker.at)
    const turn = turns.find((candidate, index) => {
      const next = turns[index + 1]
      const end = next ? Date.parse(next.startedAt ?? '') : Number.POSITIVE_INFINITY
      return time >= Date.parse(candidate.startedAt ?? '') && time < end
    })
    if (!turn) continue
    const event: TraceEvent = {
      id: `codex-compaction-${stableHash([turn.providerTurnId, marker.at]).slice(0, 16)}`,
      ts: marker.at,
      runId,
      kind: 'harness',
      stage: 'context_compaction',
      compaction: {},
      input: {},
      runtimeMetadata: { source: marker.source }
    }
    const index = turn.events.findIndex(candidate => Date.parse(candidate.ts) > time)
    turn.events.splice(index < 0 ? turn.events.length : index, 0, event)
  }
}
