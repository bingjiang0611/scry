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
 * claim. Say that instead of presenting the snapshot as the whole turn, and name the measured lag
 * between the turn's real prompt and the baseline when both are known.
 */
export function applyCaptureBaselineCaveat(
  evidence: TurnEvidence,
  capture: RecorderOpenTurnState['capture'],
  startedAt?: string
): void {
  const diffs = evidence.diff.value
  if (!capture?.baselineAt || evidence.diff.status !== 'available' || !diffs || diffs.length === 0) return
  const startedMs = startedAt ? Date.parse(startedAt) : NaN
  const baselineMs = Date.parse(capture.baselineAt)
  const lagMs = Number.isFinite(startedMs) && Number.isFinite(baselineMs) && baselineMs > startedMs
    ? baselineMs - startedMs
    : undefined
  evidence.diff = partial(
    diffs,
    evidence.diff.source,
    'session capture started mid-turn: the Git baseline was taken when this capture was applied, so changes this turn made before it are not in this snapshot' +
      (lagMs != null ? ` (baseline ${lagMs} ms after the prompt)` : ''),
    'exact'
  )
}

/**
 * State what an integrator's exclusion cost the diff, from the snapshots' own evidence: the declared
 * paths that matched and how many files they removed. Only paths and counts — never file bodies.
 */
export function applyDiffExcludeEvidence(evidence: TurnEvidence): void {
  const diffs = evidence.diff.value
  if (!diffs?.length) return
  if (evidence.diff.status !== 'available' && evidence.diff.status !== 'partial') return
  const excluded = diffs.filter((diff) => diff.diffExclude)
  if (excluded.length === 0) return
  const files = excluded.reduce((total, diff) => total + (diff.diffExclude?.files ?? 0), 0)
  const paths = [...new Set(excluded.flatMap((diff) => diff.diffExclude?.paths ?? []))].sort()
  const note = `${files} file(s) were left out of this diff by the integrator's excluded path(s): ${paths.join(', ')}`
  const previous = evidence.diff.status === 'partial' ? evidence.diff.omissionReason : undefined
  evidence.diff = partial(
    diffs,
    evidence.diff.source,
    previous ? `${previous}; ${note}` : note,
    evidence.diff.quality ?? 'exact'
  )
}
