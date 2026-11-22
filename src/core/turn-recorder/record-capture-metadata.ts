import { partial, type AgentTurnRecord, type TurnEvidence } from '../../shared/turn-record.js'
import type { RecorderOpenTurnState } from './runtime-state.js'

export function captureRecordMetadata(
  capture: RecorderOpenTurnState['capture']
): { capture?: AgentTurnRecord['capture'] } {
  if (!capture) return {}
  return {
    capture: {
      protocol: capture.protocol,
      captureId: capture.captureId,
      source: capture.source,
      task: capture.task,
      ...(capture.client ? { client: capture.client } : {})
    }
  }
}

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
    'exact',
    ['baseline_after_turn_start']
  )
}

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
    evidence.diff.quality ?? 'exact',
    [...(evidence.diff.omissionCodes ?? []), 'diff_exclude']
  )
}
