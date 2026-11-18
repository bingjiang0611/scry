// Trims finished pairing history so the 64-entry tables cannot fill up for good
// (P5-host-security §4.5). Pure: the authority applies the result inside the same
// commit as the operation that needed room, so the file is never half-cleaned.
import type { DeviceGrant, PairingRecord, PairingState } from './pairing-state'

/** Newest finished invitations, and newest revoked/lapsed grants, kept as visible history. */
export const PAIRING_HISTORY = 16

/**
 * Returns `state` itself when nothing goes, otherwise a subset of it in the same
 * order and shape, so an older reader still accepts the file. Removed:
 * - cancelled, expired and rejected invitations beyond the newest 16 (by createdAt);
 * - revoked or lapsed grants beyond the newest 16 (by when they stopped working),
 *   each WITH its `paired` record, since the reader requires a record per grant.
 * Never removed: a live grant or its record (an approved device claims its
 * certificate from that record, whatever the invitation window), a pending
 * invitation, or the App's current local grant even after it lapsed.
 * Removing only ever withdraws: a removed record answers `unknown_pairing`.
 */
export function pruneStalePairings(state: PairingState, now: number): PairingState {
  const staleGrants = state.grants.filter(g => g.revokedAt !== null || (g.scope !== 'local' && g.expiresAt <= now))
  const grants = oldest(staleGrants, g => Math.min(g.revokedAt ?? g.expiresAt, g.expiresAt))
  const finished = state.pairings.filter(p => p.state === 'cancelled' || p.state === 'expired' || p.state === 'rejected')
  const pairings = oldest(finished, p => p.createdAt)
  if (grants.size === 0 && pairings.size === 0) return state
  // pairingId is unique, and each grant's record carries its pairingId and deviceId.
  const owned = new Set([...grants].map(g => `${g.pairingId}\0${g.deviceId}`))
  const ownedBy = (p: PairingRecord) => p.state === 'paired' && owned.has(`${p.pairingId}\0${p.deviceId}`)
  return { ...state, grants: state.grants.filter(g => !grants.has(g)), pairings: state.pairings.filter(p => !pairings.has(p) && !ownedBy(p)) }
}

// The entries beyond the newest PAIRING_HISTORY; equal times fall back to file order.
function oldest<T extends DeviceGrant | PairingRecord>(items: T[], time: (item: T) => number): Set<T> {
  if (items.length <= PAIRING_HISTORY) return new Set()
  const ranked = items.map((item, index) => ({ item, index, at: time(item) })).sort((a, b) => a.at - b.at || a.index - b.index)
  return new Set(ranked.slice(0, items.length - PAIRING_HISTORY).map(entry => entry.item))
}
