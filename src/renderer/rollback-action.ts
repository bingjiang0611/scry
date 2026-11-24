import { ROLLBACK_COPY } from './constants/rollback-copy'

export interface RollbackContext {
  /** The run to roll back, or null when nothing is focused. */
  runId: string | null
  /** Whether the host has a checkpoint for it. */
  hasCheckpoint: boolean
  /** The host can serve the op at all (the App is talking to a daemon that knows it). */
  available: boolean
  busy: boolean
}

export type RollbackDecision =
  | { allowed: true }
  | { allowed: false; reason: string }

/**
 * D5: rolling back rewrites the worktree, so the entry only offers what the host can actually do.
 * A missing checkpoint is refused here with the reason the user needs, not silently disabled.
 */
export function rollbackDecision(context: RollbackContext): RollbackDecision {
  if (!context.available) return { allowed: false, reason: ROLLBACK_COPY.unavailable }
  if (!context.runId) return { allowed: false, reason: ROLLBACK_COPY.noRun }
  if (!context.hasCheckpoint) return { allowed: false, reason: ROLLBACK_COPY.noCheckpoint }
  if (context.busy) return { allowed: false, reason: ROLLBACK_COPY.working }
  return { allowed: true }
}

export type RollbackOutcome =
  | { status: 'done' }
  | { status: 'refused'; message: string }
  /** The send failed in a way that may or may not have reached the host: never retried blindly. */
  | { status: 'unknown'; message: string }

/**
 * What to tell the user after the host answered, or after the call failed without a clear answer.
 * The host's own restore result is `{ status: 'restored' }` or `{ status: 'unavailable', reason }`;
 * anything else means we do not know whether the worktree was rewritten, and must say so.
 */
export function rollbackOutcome(answer: unknown): RollbackOutcome {
  const value = (answer ?? {}) as { status?: unknown; reason?: unknown }
  if (value.status === 'restored') return { status: 'done' }
  if (value.status === 'unavailable') {
    const reason = typeof value.reason === 'string' && value.reason.length > 0 ? value.reason : 'unknown'
    return { status: 'refused', message: ROLLBACK_COPY.refused(reason) }
  }
  return { status: 'unknown', message: ROLLBACK_COPY.unknown }
}
