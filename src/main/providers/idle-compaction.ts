/**
 * C5: a kept Claude session pays for its prompt cache after every turn. When the cache is about to
 * expire, sending `/compact` before it does is cheaper than letting the next turn re-read the whole
 * conversation cold.
 *
 * The rule is deliberately narrow: compact only when the session has been idle long enough that the
 * cache window is nearly over, never twice for the same idle period, and never while a turn runs.
 */
export const COMPACTION_CACHE_TTL_MS = 5 * 60_000
/** Compact this long before the cache expires, so the `/compact` turn itself still reads warm. */
export const COMPACTION_LEAD_MS = 2 * 60_000
export const COMPACTION_DEFAULT_ENABLED = true

export interface IdleCompactionSettings {
  enabled: boolean
  cacheTtlMs: number
  leadMs: number
}

export function idleCompactionSettings(
  env: Readonly<Record<string, string | undefined>>
): IdleCompactionSettings {
  // Off only when explicitly disabled: the alignment asks for on-by-default with a way out.
  const enabled = env.SCRY_IDLE_COMPACTION?.trim() !== '0'
  return { enabled, cacheTtlMs: COMPACTION_CACHE_TTL_MS, leadMs: COMPACTION_LEAD_MS }
}

export interface IdleCompactionState {
  /** When the last turn of this session settled. */
  lastActiveAt: number | undefined
  /** The idle period that already produced a compaction, so one idle window compacts once. */
  compactedFor: number | undefined
  busy: boolean
}

export type IdleCompactionDecision =
  | { status: 'disabled' }
  | { status: 'busy' }
  | { status: 'waiting'; at: number }
  | { status: 'compact'; at: number }

/**
 * `at` is when the decision becomes due: the cache expiry minus the lead. Computing it here keeps the
 * timer dumb and the rule testable without a clock.
 */
export function decideIdleCompaction(
  state: IdleCompactionState,
  settings: IdleCompactionSettings,
  now: number
): IdleCompactionDecision {
  if (!settings.enabled) return { status: 'disabled' }
  if (state.busy) return { status: 'busy' }
  if (state.lastActiveAt === undefined) return { status: 'busy' }
  const at = state.lastActiveAt + settings.cacheTtlMs - settings.leadMs
  if (state.compactedFor === state.lastActiveAt) return { status: 'waiting', at: Number.POSITIVE_INFINITY }
  if (now < at) return { status: 'waiting', at }
  return { status: 'compact', at }
}

export const COMPACT_COMMAND = '/compact'

/**
 * Owns the timer for one kept session. `send` is the session's own input path, so the compaction is an
 * ordinary turn the user can see and stop, not a hidden side channel.
 */
export function createIdleCompaction(options: {
  settings: () => IdleCompactionSettings
  send: (command: string) => void
  now?: () => number
  schedule?: (fn: () => void, ms: number) => { unref?: () => void }
}): {
  /** The session settled, so a new idle window starts. */
  noteSettled(at?: number): void
  noteBusy(): void
  pump(): void
  stop(): void
} {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  let lastActiveAt: number | undefined
  let compactedFor: number | undefined
  let busy = false
  let timer: { unref?: () => void } | undefined

  const clear = (): void => {
    if (!timer) return
    clearTimeout(timer as never)
    timer = undefined
  }

  const pump = (): void => {
    clear()
    const decision = decideIdleCompaction({ lastActiveAt, compactedFor, busy }, options.settings(), now())
    if (decision.status === 'compact') {
      compactedFor = lastActiveAt
      options.send(COMPACT_COMMAND)
      return
    }
    if (decision.status !== 'waiting' || !Number.isFinite(decision.at)) return
    timer = schedule(() => pump(), Math.max(0, decision.at - now()))
    timer.unref?.()
  }

  return {
    noteSettled(at) {
      busy = false
      lastActiveAt = at ?? now()
      pump()
    },
    noteBusy() {
      busy = true
      clear()
    },
    pump,
    stop: clear
  }
}
