import { partial, type AgentTurnRecord, type TurnEvidence } from '../../shared/turn-record.js'
import type { RecorderOpenTurnState } from './runtime-state.js'

/**
 * A record states its own capture provenance: which claim opened the session, why, and the caller's
 * verbatim task string. Absent means ordinary recording — never "captured without a claim".
 */
export function captureRecordMetadata(
  capture: RecorderOpenTurnState['capture']
): { capture?: AgentTurnRecord['capture'] } {
  if (!capture) return {}
  return {
    capture: {
      protocol: capture.protocol,
      captureId: capture.captureId,
      source: capture.source,
      task: capture.task
    }
  }
}

/**
 * A claim happens mid-turn, so its Git baseline cannot contain work the turn already did before the
 * claim. Say that instead of presenting the snapshot as the whole turn.
 */
export function applyCaptureBaselineCaveat(
  evidence: TurnEvidence,
  capture: RecorderOpenTurnState['capture']
): void {
  const diffs = evidence.diff.value
  if (!capture?.baselineAt || evidence.diff.status !== 'available' || !diffs || diffs.length === 0) return
  evidence.diff = partial(
    diffs,
    evidence.diff.source,
    'session capture started mid-turn: the Git baseline was taken at the claim, so changes this turn made before it are not in this snapshot',
    'exact'
  )
}
