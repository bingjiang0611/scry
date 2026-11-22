import { performance } from 'node:perf_hooks'
import type { HostAdminNotice } from '../../shared/host-admin'
import type { AgentDataUpdated } from '../../shared/runtime'
import type { SessionAttentionSnapshot } from '../../shared/session-attention'
import { SUBSCRIBE_RETAINED_WINDOW_NOTICES, type SubscribeHint } from '../../shared/orchestration-subscribe'

const DEFAULT_COALESCE_MS = 50
const MAX_HINT_BUFFER = 512
const MAX_HINT_CURSORS_PER_DEVICE = 512
const MAX_LIVE_RUN_META = 1_024

export interface LiveRunRuntimeMeta {
  scryRunId?: string
  admitted?: boolean
  outputSeq: number
  cwd?: string
  providerId?: string
  agentProfileId?: string
  externalSessionId?: string
}

interface HintEntry {
  seq: number
  hint: SubscribeHint
  coalesceKey?: string
}

interface CoalesceSlot {
  lastEmittedAt: number
  pending?: SubscribeHint
  timer?: ReturnType<typeof setTimeout>
}

function deviceFingerprint(cursor: string): string {
  const suffix = cursor.indexOf(':')
  return suffix < 0 ? cursor : cursor.slice(0, suffix)
}

export interface SubscribeHubOptions {
  /** Leading-edge coalescing window for volatile hints (protocol §5.3: 50 ms). */
  coalesceMs?: number
  /** Snapshot-time volatile state hints (e.g. unread attention snapshot). */
  stateHints?: () => SubscribeHint[]
  now?: () => number
}

/**
 * In-memory volatile hint hub and commit-wakeup fanout for `subscribe` (protocol §5.3).
 * Durable events come from `EventSink`; volatile hints (run output, terminal, oauth,
 * W11 hostNotice, retained non-run window notices, attention) flow here without touching SQLite.
 */
export class SubscribeHub {
  readonly #coalesceMs: number
  readonly #stateHints: () => SubscribeHint[]
  readonly #now: () => number
  readonly #waiters = new Set<() => void>()
  readonly #entries: HintEntry[] = []
  readonly #localHintSeq = new Map<string, number>()
  readonly #deviceHintSeq = new Map<string, Map<string, number>>()
  readonly #coalesce = new Map<string, CoalesceSlot>()
  readonly #liveRunMeta = new Map<string, LiveRunRuntimeMeta>()
  #hintSeq = 0
  #commitSeq = 0
  #closed = false
  #reading = 0
  #lastRead: number

  constructor(options: SubscribeHubOptions = {}) {
    this.#coalesceMs = Math.max(0, options.coalesceMs ?? DEFAULT_COALESCE_MS)
    this.#stateHints = options.stateHints ?? (() => [])
    this.#now = options.now ?? (() => performance.now())
    this.#lastRead = this.#now()
  }

  get closed(): boolean {
    return this.#closed
  }

  get commitSeq(): number {
    return this.#commitSeq
  }

  /** How long no local subscribe call has been active (used by terminal idle timeout). */
  idleMs(): number {
    return this.#reading > 0 ? 0 : Math.max(0, this.#now() - this.#lastRead)
  }

  beginRead(): void {
    this.#reading += 1
  }

  endRead(): void {
    this.#reading = Math.max(0, this.#reading - 1)
    this.#lastRead = this.#now()
  }

  /** Called synchronously after `EventSink` commits; wakes all parked subscribers immediately. */
  notifyCommit(seq: number): void {
    if (seq > this.#commitSeq) this.#commitSeq = seq
    this.#wake()
  }

  liveRunMeta(runId: string): LiveRunRuntimeMeta | undefined {
    return this.#liveRunMeta.get(runId)
  }

  #ensureRunMeta(runId: string): LiveRunRuntimeMeta {
    let meta = this.#liveRunMeta.get(runId)
    if (!meta) {
      meta = { outputSeq: 0 }
      this.#liveRunMeta.set(runId, meta)
      while (this.#liveRunMeta.size > MAX_LIVE_RUN_META) {
        const oldest = this.#liveRunMeta.keys().next().value
        if (oldest === undefined) break
        this.#liveRunMeta.delete(oldest)
      }
    }
    return meta
  }

  #buildRunHint(runId: string, meta: LiveRunRuntimeMeta): SubscribeHint {
    return {
      kind: 'run',
      runId,
      outputSeq: meta.outputSeq,
      ...(meta.scryRunId ? { scryRunId: meta.scryRunId } : {}),
      ...(meta.admitted ? { admitted: true } : {}),
      ...(meta.cwd ? { cwd: meta.cwd } : {}),
      ...(meta.providerId ? { providerId: meta.providerId } : {}),
      ...(meta.agentProfileId ? { agentProfileId: meta.agentProfileId } : {}),
      ...(meta.externalSessionId ? { externalSessionId: meta.externalSessionId } : {})
    }
  }

  /** Records canonical scryRunId/context bind without adding a pre-first-token SQLite fsync. */
  noteRunBound(
    runId: string,
    info: { scryRunId: string; cwd?: string; providerId?: string; agentProfileId?: string }
  ): void {
    if (this.#closed) return
    const meta = this.#ensureRunMeta(runId)
    meta.scryRunId = info.scryRunId
    if (info.cwd) meta.cwd = info.cwd
    if (info.providerId) meta.providerId = info.providerId
    if (info.agentProfileId) meta.agentProfileId = info.agentProfileId
    this.#emitUrgent(`run:${runId}`, this.#buildRunHint(runId, meta))
  }

  /** Records canonical pipeline registration (admitted) immediately on the volatile hint channel. */
  noteRunAdmitted(runId: string, scryRunId?: string): void {
    if (this.#closed) return
    const meta = this.#ensureRunMeta(runId)
    if (scryRunId) meta.scryRunId = scryRunId
    meta.admitted = true
    this.#emitUrgent(`run:${runId}`, this.#buildRunHint(runId, meta))
  }

  noteRunSession(runId: string, externalSessionId: string): void {
    if (this.#closed) return
    const meta = this.#ensureRunMeta(runId)
    meta.externalSessionId = externalSessionId
  }

  /** Emits a run output hint with leading-edge 50 ms coalescing per run. */
  noteRunOutput(runId: string, outputSeq?: number): void {
    if (this.#closed) return
    const meta = this.#ensureRunMeta(runId)
    meta.outputSeq = outputSeq !== undefined ? Math.max(meta.outputSeq, outputSeq) : meta.outputSeq + 1
    this.#emitCoalesced(`run:${runId}`, this.#buildRunHint(runId, meta))
  }

  noteRunTerminal(runId: string): void {
    const slot = this.#coalesce.get(`run:${runId}`)
    if (slot?.timer) clearTimeout(slot.timer)
    if (slot?.pending) {
      const pending = slot.pending
      slot.pending = undefined
      slot.timer = undefined
      this.#pushEntry(pending, `run:${runId}`)
    }
    this.#coalesce.delete(`run:${runId}`)
  }

  emitTerminal(): void {
    if (this.#closed) return
    this.#emitCoalesced('terminal', { kind: 'terminal' })
  }

  emitOAuth(url: string): void {
    if (this.#closed) return
    this.#pushEntry({ kind: 'oauth', url })
  }

  /** P5 W11 host-admin notice: never coalesced, exact payload preserved. */
  emitHostNotice(notice: HostAdminNotice): void {
    if (this.#closed) return
    this.#pushEntry({ kind: 'hostNotice', notice })
  }

  emitAttention(snapshot: SessionAttentionSnapshot): void {
    if (this.#closed) return
    this.#pushEntry({ kind: 'attention', snapshot }, 'attention')
  }

  emitWindowNotice(channel: string, payload: unknown): void {
    if (this.#closed || !SUBSCRIBE_RETAINED_WINDOW_NOTICES.has(channel)) return
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
    this.#pushEntry({ kind: 'window', channel, payload: payload as Record<string, unknown> })
  }

  emitDataNotice(event: AgentDataUpdated): void {
    if (this.#closed) return
    const key =
      'kind' in event && event.kind === 'conversation_changed'
        ? `conversation:${event.conversationId}`
        : 'kind' in event && event.kind === 'catalog_recovered'
          ? 'catalog'
          : undefined
    this.#pushEntry({ kind: 'data', event }, key)
  }

  hasPendingHints(peer: string, local = false): boolean {
    const cursors = local ? this.#localHintSeq : this.#deviceHintSeq.get(deviceFingerprint(peer))
    const last = cursors?.get(peer) ?? 0
    return this.#entries.some((entry) => entry.seq > last)
  }

  /** Drains undelivered hints for `peer`; when `includeState` is true (snapshot), prepends state hints. */
  drainHints(peer: string, includeState: boolean, fresh = false, local = false): SubscribeHint[] {
    // A client with no cursor (first connect, or an App restart) gets the current
    // state only, never a replay of volatile hints it never saw: the legacy appEvents
    // feed behaves the same, and replaying would re-show old notices and errors.
    const cursors = local ? this.#localHintSeq : this.#deviceCursors(deviceFingerprint(peer))
    const last = fresh ? this.#hintSeq : (cursors.get(peer) ?? 0)
    const drained = this.#entries.filter((entry) => entry.seq > last).map((entry) => entry.hint)
    cursors.delete(peer)
    cursors.set(peer, this.#hintSeq)
    if (!local && cursors.size > MAX_HINT_CURSORS_PER_DEVICE) {
      const oldest = cursors.keys().next().value
      if (oldest !== undefined) cursors.delete(oldest)
    }
    if (!includeState) return drained
    const state = this.#stateHints()
    if (state.length === 0) return drained
    const hasAttentionInDrained = drained.some((h) => h.kind === 'attention')
    const filteredState = hasAttentionInDrained ? state.filter((h) => h.kind !== 'attention') : state
    return [...filteredState, ...drained]
  }

  #deviceCursors(fingerprint: string): Map<string, number> {
    let cursors = this.#deviceHintSeq.get(fingerprint)
    if (!cursors) {
      cursors = new Map()
      this.#deviceHintSeq.set(fingerprint, cursors)
    }
    return cursors
  }

  waitForWake(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.#closed || timeoutMs <= 0 || signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#waiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      timer.unref?.()
      this.#waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const slot of this.#coalesce.values()) {
      if (slot.timer) clearTimeout(slot.timer)
    }
    this.#coalesce.clear()
    this.#wake()
  }

  #emitUrgent(key: string, hint: SubscribeHint): void {
    const slot = this.#coalesce.get(key)
    if (slot) {
      if (slot.timer) clearTimeout(slot.timer)
      slot.timer = undefined
      slot.pending = undefined
      slot.lastEmittedAt = this.#now()
    } else {
      this.#coalesce.set(key, { lastEmittedAt: this.#now() })
    }
    this.#pushEntry(hint, key)
  }

  #emitCoalesced(key: string, hint: SubscribeHint): void {
    const now = this.#now()
    let slot = this.#coalesce.get(key)
    if (!slot) {
      slot = { lastEmittedAt: now }
      this.#coalesce.set(key, slot)
      this.#pushEntry(hint, key)
      return
    }
    const elapsed = now - slot.lastEmittedAt
    if (this.#coalesceMs === 0 || (elapsed >= this.#coalesceMs && !slot.timer)) {
      slot.lastEmittedAt = now
      slot.pending = undefined
      this.#pushEntry(hint, key)
      return
    }
    slot.pending = hint
    if (!slot.timer) {
      const delay = Math.max(1, this.#coalesceMs - elapsed)
      slot.timer = setTimeout(() => {
        slot!.timer = undefined
        if (this.#closed || !slot!.pending) return
        const pending = slot!.pending
        slot!.pending = undefined
        slot!.lastEmittedAt = this.#now()
        this.#pushEntry(pending, key)
      }, delay)
      slot.timer.unref?.()
    }
  }

  #pushEntry(hint: SubscribeHint, coalesceKey?: string): void {
    if (coalesceKey !== undefined) {
      const idx = this.#entries.findIndex((e) => e.coalesceKey === coalesceKey)
      if (idx >= 0) this.#entries.splice(idx, 1)
    }
    this.#entries.push({ seq: ++this.#hintSeq, hint, ...(coalesceKey !== undefined ? { coalesceKey } : {}) })
    while (this.#entries.length > MAX_HINT_BUFFER) this.#entries.shift()
    this.#wake()
  }

  #wake(): void {
    const waiters = [...this.#waiters]
    this.#waiters.clear()
    for (const wake of waiters) wake()
  }
}
