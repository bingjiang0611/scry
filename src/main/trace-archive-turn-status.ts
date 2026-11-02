/**
 * Outcome of one archived turn whose recorder wrote no explicit `status`.
 *
 * A legacy archive can hold `done: true` with no status. Derivation uses only structured
 * evidence the record itself carries: a top-level `error`, or the turn's terminal `result`
 * event and its `isError` verdict. Visible text is never read as a verdict, and "no
 * evidence at all" stays unknown (`unavailable`) instead of becoming `completed`.
 */
export type ArchivedTurnStatus = 'completed' | 'failed' | 'unavailable'

/** Status a legacy turn carries when its own record proves no outcome. */
export const ARCHIVED_TURN_STATUS_UNKNOWN: ArchivedTurnStatus = 'unavailable'

export interface ArchivedTurnEvidence {
  /** Top-level recorder error text, when the archive carried a string. */
  error?: string
  /** Any terminal `result` event of this turn said `isError: true`. */
  resultIsError?: boolean
  /** Any terminal `result` event of this turn said `isError: false`. */
  resultSucceeded?: boolean
}

export function archivedTurnStatus(evidence: ArchivedTurnEvidence): ArchivedTurnStatus {
  if (evidence.error !== undefined && evidence.error.trim() !== '') return 'failed'
  if (evidence.resultIsError === true) return 'failed'
  if (evidence.resultSucceeded === true) return 'completed'
  return ARCHIVED_TURN_STATUS_UNKNOWN
}
