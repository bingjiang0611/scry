import { historyProfileSelection, historyScopeSelection } from './remote-gateway'

// Wire-level constants and limits of the phone-facing inner-mTLS protocol,
// shared by the host, its connection handler and its request dispatch.

// Remote prompts may carry a small, explicitly bounded image/text attachment.
// The relay still sees only inner-TLS ciphertext; 1.25 MiB is enough for the
// mobile attachment budget while preventing unbounded buffering.
export const DEFAULT_MAX_FRAME = 1_310_720

// Idle timeout for a kept-alive lane. Current phones ping every 15 s while in
// the foreground, so a lane survives a missed ping; older phones close their
// own lanes after 20 s and are unaffected.
export const INNER_IDLE_TIMEOUT_MS = 75_000

// Transport features this host offers, reported by `ping` so a phone can use
// them without guessing from errors. Values are added as each one ships.
export const HOST_TRANSPORT_CAPABILITIES: readonly string[] = ['ping', 'mux', 'watchStream', 'sessionsKnown', 'historyDeflate']

// Pushed run observation on a multiplexed lane. One request, many replies with
// the same id: `more: true` until the run is terminal or the stream expires,
// then a final `more: false`. Each pass waits at most this long, so an idle run
// still sends a heartbeat that keeps the phone's deadline and cursors current.
export const WATCH_STREAM_WAIT_MS = 15_000
// A stream ends (more: false, not terminal) after this long; the phone simply
// subscribes again with its cursors. Bounds a stream abandoned by a phone that
// vanished without closing the tunnel.
export const WATCH_STREAM_MAX_MS = 10 * 60_000
export const MAX_STREAMS_PER_LANE = 8

// Concurrent requests one multiplexed lane may run. Superseded long-polls stay
// on the host until their own wait ends, so leave room for several of them.
export const MAX_MUX_INFLIGHT = 32

export function isMuxId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

// `history` joins one opened session's version to the liveRuns long-poll.
// Returns undefined when absent and false when malformed.
export function parseLiveRunsHistory(value: unknown): { query: { providerId: string; cwd: string; externalSessionId: string; historyScope: 'session' | 'profile'; agentProfileId?: string | null }; known?: string } | undefined | false {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const h = value as Record<string, unknown>
  const text = (field: unknown, max: number): field is string => typeof field === 'string' && field.length > 0 && field.length <= max
  if (!text(h.providerId, 128) || !text(h.cwd, 4096) || !text(h.externalSessionId, 256)) return false
  if (h.known !== undefined && !text(h.known, 512)) return false
  const scope = historyScopeSelection(h).historyScope ?? 'profile'
  const profile = scope === 'profile' ? historyProfileSelection(h, true) : historyProfileSelection(h)
  return { query: { providerId: h.providerId, cwd: h.cwd, externalSessionId: h.externalSessionId, historyScope: scope, ...profile }, ...(h.known !== undefined ? { known: h.known as string } : {}) }
}
