import { stat } from 'node:fs/promises'

export const CLOSING_TURN_EXPIRED_REASON =
  'turn received its terminal event but produced no new evidence before the closing silence window closed'

/**
 * Whether a `closing` turn has gone silent long enough to force a decision. Progress is measured by
 * when the recorder last wrote the state, not by `closingAt`: that field carries a Provider clock, and
 * a skewed or stale one must not trigger a decision about diff evidence. Every real transition writes
 * the state file, so a live turn keeps resetting this window. An unreadable state declines to force,
 * because giving up needs positive proof.
 */
export async function closingTurnStalled(path: string, expiryMs: number, now = Date.now()): Promise<boolean> {
  const touchedAt = await stat(path).then((info) => info.mtimeMs).catch(() => Number.NaN)
  if (!Number.isFinite(touchedAt)) return false
  return now - touchedAt >= expiryMs
}

/**
 * A deferred terminal is held back until the transcript stops moving. Once the turn is reopened, that
 * earlier terminal no longer describes the turn: it predates everything the reopen is waiting for.
 */
export function transcriptTerminalPredatesReopen(open: { reopenedAt?: string }, completedAt: string | undefined): boolean {
  if (!open.reopenedAt || !completedAt) return false
  const completed = Date.parse(completedAt)
  const reopened = Date.parse(open.reopenedAt)
  if (!Number.isFinite(completed) || !Number.isFinite(reopened)) return false
  return completed <= reopened
}
