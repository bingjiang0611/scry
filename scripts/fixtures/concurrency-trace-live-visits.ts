// Measurement-only visit ledger for the live concurrency trace fixture (R6.2).
//
// Pure bookkeeping shared by the renderer driver and its focused test: the round
// budget (one visit = 7 real polls), the controlled read contract for each round,
// the mount-time reads reported separately, and a bounded keeper for the ActiveRun
// objects React actually committed.
//
// This class only tracks the visit lifetime. It does not measure CPU: process CPU
// sampling is external (launcher, separate process) and happens after the visit is
// sealed, which is also why the launcher — not this class — decides when to take
// the kept views.
//
// No DOM, no timers, no wall clock: the caller passes measurements in.

export const LIVE_ROUNDS = 7
export const MAX_KEPT_VIEWS = LIVE_ROUNDS

// Fixture ABI names shared by the renderer bundle, the generated preload and the
// build-time instrumentation. They live here so the literals cannot drift.
export const LIVE_BRIDGE_KEY = '__scryTraceLiveHost'
export const LIVE_DRIVER_KEY = '__scryTraceLive'

/**
 * Reads every round must make, exactly. This lane follows a run the host keeps
 * alive: one intents read, one liveRun read and one delta read. A full snapshot
 * (`trace`) or a second delta (gap re-read) is a violation, and so is zero reads.
 */
export const REQUIRED_ROUND_CALLS: Record<string, number> = { intents: 1, liveRun: 1, traceDelta: 1 }

/** Result of locating the marker node and measuring its layout. */
export interface LiveMarkerCheck { visible: boolean; reason: string; width: number; height: number }

export interface LiveRoundSample {
  round: number
  /** Calling the registered poll until its promise settles. */
  pollMs: number
  /** Two animation frames after the poll: DOM settlement, not screen paint. */
  settleMs: number
  /** Locating and measuring the marker node, excluded from pollMs/settleMs. */
  markerCheckMs: number
  marker: LiveMarkerCheck
  commits: number
  commitMs: number
  autoPolls: number
  calls: Record<string, number>
  failed: Record<string, number>
  /** Empty only when the controlled read contract held for this round. */
  violations: string[]
}

export interface LiveVisitSummary {
  visitId: string
  rounds: number
  /** Wall time from beginVisit to the sealed visit, not CPU time. */
  visitWallMs: number
  /** Reads issued between mount and the first round (list/catalog/history setup). */
  mountCalls: Record<string, number>
  mountFailed: Record<string, number>
  /** Sum of the per-round deltas only. */
  roundCalls: Record<string, number>
  roundFailed: Record<string, number>
  /** mountCalls + roundCalls: the whole visit, nothing hidden. */
  calls: Record<string, number>
  failed: Record<string, number>
  violations: string[]
  keptViews: number
}

export interface LiveCallCounts {
  calls: Record<string, number>
  failed: Record<string, number>
}

function sumInto(total: Record<string, number>, part: Record<string, number>): void {
  for (const [method, count] of Object.entries(part)) total[method] = (total[method] ?? 0) + count
}

/** Per-round delta of a monotonic per-method counter. */
export function callDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const delta: Record<string, number> = {}
  for (const method of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[method] ?? 0) - (before[method] ?? 0)
    if (change !== 0) delta[method] = change
  }
  return delta
}

/**
 * One round is accepted only when every required read ran exactly once, nothing
 * else ran, and no read failed. Zero reads cannot pass: the required counts are
 * checked for equality, not as an upper bound.
 */
export function roundViolations(round: LiveCallCounts): string[] {
  const violations: string[] = []
  for (const [method, required] of Object.entries(REQUIRED_ROUND_CALLS)) {
    const count = round.calls[method] ?? 0
    if (count !== required) violations.push(`${method}:${count}!=${required}`)
  }
  for (const [method, count] of Object.entries(round.calls)) {
    if (method in REQUIRED_ROUND_CALLS || count === 0) continue
    violations.push(`unexpected:${method}:${count}`)
  }
  for (const [method, count] of Object.entries(round.failed)) {
    if (count > 0) violations.push(`failed:${method}:${count}`)
  }
  return violations.sort()
}

interface OpenVisit {
  visitId: string
  startedAtMs: number
  samples: LiveRoundSample[]
  views: unknown[]
  mount?: LiveCallCounts
  violations: string[]
}

interface SealedVisit {
  summary: LiveVisitSummary
  views: unknown[]
  released: boolean
}

export class LiveVisitLedger {
  private open: OpenVisit | undefined
  private sealed: SealedVisit | undefined

  private requireOpen(): OpenVisit {
    if (!this.open) throw new Error('concurrency_trace_live_visit_closed')
    return this.open
  }

  private requireSealed(): SealedVisit {
    if (!this.sealed) throw new Error('concurrency_trace_live_visit_open')
    return this.sealed
  }

  begin(visitId: string, atMs: number): void {
    if (typeof visitId !== 'string' || visitId.length === 0) throw new Error('concurrency_trace_live_invalid_visit_id')
    if (this.open) throw new Error('concurrency_trace_live_visit_open')
    if (this.sealed && !this.sealed.released) throw new Error('concurrency_trace_live_views_not_released')
    this.open = { visitId, startedAtMs: atMs, samples: [], views: [], violations: [] }
    this.sealed = undefined
  }

  /** Reads issued before the first round; recorded once so setup is never hidden. */
  recordMount(counts: LiveCallCounts): void {
    const visit = this.requireOpen()
    if (visit.samples.length > 0) throw new Error('concurrency_trace_live_mount_after_round')
    if (visit.mount) throw new Error('concurrency_trace_live_mount_recorded')
    visit.mount = { calls: { ...counts.calls }, failed: { ...counts.failed } }
    for (const [method, count] of Object.entries(counts.failed)) {
      if (count > 0) visit.violations.push(`mount_failed:${method}:${count}`)
    }
  }

  /**
   * Records one finished round. `publishedRun` is the ActiveRun object reference
   * React committed for that round — never a copy.
   */
  recordRound(sample: LiveRoundSample, publishedRun: unknown): void {
    const visit = this.requireOpen()
    if (!visit.mount) throw new Error('concurrency_trace_live_mount_not_recorded')
    if (sample.round !== visit.samples.length + 1) throw new Error('concurrency_trace_live_round_out_of_order')
    if (visit.samples.length >= LIVE_ROUNDS) throw new Error('concurrency_trace_live_round_overflow')
    if (visit.views.length >= MAX_KEPT_VIEWS) throw new Error('concurrency_trace_live_view_overflow')
    visit.samples.push(sample)
    visit.views.push(publishedRun ?? null)
    for (const item of sample.violations) if (!visit.violations.includes(item)) visit.violations.push(item)
  }

  /** Seals the visit. The launcher takes the kept views after its own sampling. */
  end(atMs: number): LiveVisitSummary {
    const visit = this.requireOpen()
    if (!visit.mount) throw new Error('concurrency_trace_live_mount_not_recorded')
    if (visit.samples.length !== LIVE_ROUNDS) throw new Error('concurrency_trace_live_rounds_incomplete')
    this.open = undefined
    const roundCalls: Record<string, number> = {}
    const roundFailed: Record<string, number> = {}
    for (const sample of visit.samples) {
      sumInto(roundCalls, sample.calls)
      sumInto(roundFailed, sample.failed)
    }
    const calls = { ...visit.mount.calls }
    sumInto(calls, roundCalls)
    const failed = { ...visit.mount.failed }
    sumInto(failed, roundFailed)
    const summary: LiveVisitSummary = {
      visitId: visit.visitId,
      rounds: visit.samples.length,
      visitWallMs: atMs - visit.startedAtMs,
      mountCalls: visit.mount.calls,
      mountFailed: visit.mount.failed,
      roundCalls,
      roundFailed,
      calls,
      failed,
      violations: [...visit.violations].sort(),
      keptViews: visit.views.length
    }
    this.sealed = { summary, views: visit.views, released: false }
    return summary
  }

  /** Hands the committed-run references to the launcher; no copying, no serializing. */
  takeViews(): readonly unknown[] {
    return [...this.requireSealed().views]
  }

  releaseViews(): number {
    const sealed = this.requireSealed()
    if (sealed.released) return 0
    const released = sealed.views.length
    sealed.views.length = 0
    sealed.released = true
    return released
  }

  state(): { open: boolean; visitId?: string; rounds: number; keptViews: number; released: boolean } {
    if (this.open) return { open: true, visitId: this.open.visitId, rounds: this.open.samples.length, keptViews: this.open.views.length, released: false }
    if (this.sealed) return { open: false, visitId: this.sealed.summary.visitId, rounds: this.sealed.summary.rounds, keptViews: this.sealed.views.length, released: this.sealed.released }
    return { open: false, rounds: 0, keptViews: 0, released: true }
  }
}
