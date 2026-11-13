import { stat } from 'node:fs/promises'

export const CLOSING_TURN_EXPIRED_REASON =
  'turn received its terminal event but could not be finalized before the expiry window closed'

/**
 * How long a `closing` turn has been failing to finalize, measured by when the recorder last wrote
 * its state rather than by `closingAt`: that field carries a Provider clock, and a skewed or stale
 * one must not trigger a decision that discards diff evidence. Every real transition rewrites this
 * file, so its mtime is the recorder's own record of last progress. An unreadable state declines to
 * force, because giving up needs positive proof.
 */
export async function closingTurnStalled(path: string, expiryMs: number, now = Date.now()): Promise<boolean> {
  const touchedAt = await stat(path).then((info) => info.mtimeMs).catch(() => Number.NaN)
  if (!Number.isFinite(touchedAt)) return false
  return now - touchedAt >= expiryMs
}
