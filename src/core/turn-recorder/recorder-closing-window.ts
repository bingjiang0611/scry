import { stat } from 'node:fs/promises'

export const CLOSING_TURN_EXPIRED_REASON =
  'turn received its terminal event but could not be finalized before the expiry window closed'

export async function closingTurnStalled(path: string, expiryMs: number, now = Date.now()): Promise<boolean> {
  const touchedAt = await stat(path).then((info) => info.mtimeMs).catch(() => Number.NaN)
  if (!Number.isFinite(touchedAt)) return false
  return now - touchedAt >= expiryMs
}
