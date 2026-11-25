
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
export const HOST_TRANSPORT_CAPABILITIES: readonly string[] = ['ping', 'mux', 'sessionsKnown', 'historyDeflate']

// Concurrent requests one multiplexed lane may run. Superseded long-polls stay
// on the host until their own wait ends, so leave room for several of them.
export const MAX_MUX_INFLIGHT = 32

export function isMuxId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
