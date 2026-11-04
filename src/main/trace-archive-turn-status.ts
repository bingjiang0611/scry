import { classifyRunTermination } from '../shared/runtime-termination'
import { isRunTerminationReason } from '../shared/runtime-types'

/**
 * Outcome of one archived turn whose recorder wrote no explicit `status`.
 *
 * A legacy archive can hold `done: true` with no status. Derivation uses only structured
 * evidence the record itself carries: a top-level `error`, the turn's terminal `result`
 * event with its `isError` verdict, and the structured termination that same event names.
 * Visible text is never read as a verdict, and "no evidence at all" stays unknown
 * (`unavailable`) instead of becoming `completed`.
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
  /** Structured termination the `result` event named; any known reason is a non-success. */
  terminationReason?: string
  /** Provider's own raw stop reason, understood only through the shared classifier. */
  providerStopReason?: string
}

/**
 * The turn's own termination evidence, when the record names one.
 *
 * `isError: false` only says the Provider answered. A run that stopped at an output token
 * limit, a context window, a turn cap or a budget answered too, but its result is not a
 * completed turn. An unrecognized reason string proves nothing and is ignored here.
 */
function terminated(evidence: ArchivedTurnEvidence): boolean {
  if (isRunTerminationReason(evidence.terminationReason)) return true
  return classifyRunTermination({ rawReason: evidence.providerStopReason }) !== undefined
}

export function archivedTurnStatus(evidence: ArchivedTurnEvidence): ArchivedTurnStatus {
  if (evidence.error !== undefined && evidence.error.trim() !== '') return 'failed'
  if (evidence.resultIsError === true) return 'failed'
  if (terminated(evidence)) return 'failed'
  if (evidence.resultSucceeded === true) return 'completed'
  return ARCHIVED_TURN_STATUS_UNKNOWN
}
