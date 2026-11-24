import type { LedgerEvent } from '../../main/remote/session-ledger'
import { canonicalJson, sha256Hex } from './canonical-json'
import { createConversationOrdinalResolver } from './conversation-ordinal-lookup'
import { EventSink, type EventSinkOptions } from './event-sink'
import type { OrchestrationCommand } from './orchestrator-commands'
import {
  buildProgressMarkerCommand,
  parseLedgerIntentRouting,
  type ConversationTurnSettledInfo,
  type LedgerProjectionStats,
  type OrchestrationCommitSample
} from './ledger-intent-routing'
import { INLINE_BODY_MAX_BYTES } from './types'

export {
  parseLedgerIntentRouting,
  type ConversationTurnSettledInfo,
  type LedgerProjectionStats,
  type OrchestrationCommitSample,
  type ParsedIntentRouting
} from './ledger-intent-routing'

export interface LedgerEventMeta {
  peerCertSHA256?: string
  grantScope?: 'local' | 'remote'
  answeredByPeer?: string
}

export interface LedgerProjectionMirrorOptions extends EventSinkOptions {
  leaseOwner?: string
  clock?: () => number
  /** Optional resolver returning the submitting peer cert SHA-256 and grant scope for a ledger run. */
  resolveRunMeta?: (ledgerRunId: string) => { peerCertSHA256?: string; grantScope?: 'local' | 'remote' } | undefined
  /** Optional fallback resolver returning authoritative H3 ordinal if a legacy routing detail omitted it. */
  resolveTurnOrdinal?: (sessionKey: string, runId: string) => number | undefined
  onCommitTiming?: (sample: OrchestrationCommitSample) => void
  onError?: (error: unknown) => void
}

const PEER_SHA_RE = /^[0-9a-f]{64}$/
const MAX_PENDING_BODIES = 16

/**
 * Projects `SessionLedger` lifecycle events and `ConversationStore.settle` transitions
 * into `orchestration.db` strictly through `EventSink.execute(...)` without altering
 * any user-visible run behavior (used to rebuild and verify the dispatch ledger projection).
 */
export class LedgerProjectionMirror {
  readonly sink: EventSink | null
  readonly #leaseOwner: string
  readonly #clock: () => number
  readonly #resolveRunMeta?: LedgerProjectionMirrorOptions['resolveRunMeta']
  readonly #resolveTurnOrdinal: (sessionKey: string, runId: string) => number | undefined
  readonly #onCommitTiming?: (sample: OrchestrationCommitSample) => void
  readonly #onError?: (error: unknown) => void
  readonly #ledgerToCanonical = new Map<string, string>()
  readonly #preFirstTokenCommits = new Map<string, number>()
  readonly #preFirstTokenMs = new Map<string, number>()
  readonly #pendingBodies = new Map<string, { sha256: string; content: string }>()
  #acceptedCommits = 0
  #duplicates = 0
  #rejectedSticky = 0
  #rejectedRetryable = 0
  #ordinalMismatches = 0
  #importRejections = 0
  #missingBodies = 0
  #failures = 0
  #failedOpen = false
  #deferringLegacyWatermark = false
  #maxDeferredSeq = 0

  private constructor(sink: EventSink | null, options: LedgerProjectionMirrorOptions) {
    this.sink = sink
    this.#leaseOwner = options.leaseOwner ?? `daemon:${process.pid}`
    this.#clock = options.clock ?? (() => Date.now())
    this.#resolveRunMeta = options.resolveRunMeta
    this.#resolveTurnOrdinal =
      options.resolveTurnOrdinal ?? createConversationOrdinalResolver(options.userDataDir)
    this.#onCommitTiming = options.onCommitTiming
    this.#onError = options.onError
    if (!sink) {
      this.#failures = 1
      this.#failedOpen = true
    }
  }

  static open(options: LedgerProjectionMirrorOptions): LedgerProjectionMirror {
    try {
      const sink = EventSink.open({
        ...options,
        maxActiveRuns: options.maxActiveRuns ?? 1024
      })
      return new LedgerProjectionMirror(sink, options)
    } catch (error) {
      options.onError?.(error)
      return new LedgerProjectionMirror(null, options)
    }
  }

  stats(): LedgerProjectionStats {
    return {
      acceptedCommits: this.#acceptedCommits,
      commits: this.#acceptedCommits,
      duplicates: this.#duplicates,
      rejectedSticky: this.#rejectedSticky,
      rejectedRetryable: this.#rejectedRetryable,
      ordinalMismatches: this.#ordinalMismatches,
      importRejections: this.#importRejections,
      missingBodies: this.#missingBodies,
      failures: this.#failures,
      deviations:
        this.#rejectedSticky +
        this.#rejectedRetryable +
        this.#ordinalMismatches +
        this.#importRejections +
        this.#missingBodies +
        this.#failures,
      failedOpen: this.#failedOpen,
      preFirstTokenCommitsByRun: this.#preFirstTokenCommits,
      preFirstTokenDurationMsByRun: this.#preFirstTokenMs
    }
  }

  /** Marks the mirror as failed-open (e.g. when startup import trips the sink fence). */
  markFailedOpen(error: unknown): void {
    this.failOpen(error)
  }

  /** Records rejections observed during incremental startup import so deviations stay honest. */
  recordImportRejections(count: number): void {
    if (count > 0) this.#importRejections += count
  }

  /** Records dangling external body references that could not be repaired from H1 on startup. */
  recordMissingBodies(count: number): void {
    if (count > 0) this.#missingBodies += count
  }

  /**
   * Pauses advancing `legacy_ledger_seq` on live writes while deferred historical import runs
   * after `openLocalChannel`, then flushes the highest seen live seq once backfill finishes.
   */
  setDeferringLegacyWatermark(defer: boolean, flushThroughSeq?: number): void {
    this.#deferringLegacyWatermark = defer
    if (!defer && this.sink && !this.#failedOpen && !this.sink.isWriteIndeterminate()) {
      const target = Math.max(this.#maxDeferredSeq, flushThroughSeq ?? 0)
      if (target > 0) {
        const current = Number(this.sink.getMeta('legacy_ledger_seq') ?? '0')
        if (target > current) this.sink.setMeta('legacy_ledger_seq', String(target))
      }
      this.#maxDeferredSeq = 0
    }
  }

  resolveCanonicalRunId(ledgerRunId: string): string {
    const cached = this.#ledgerToCanonical.get(ledgerRunId)
    if (cached) return cached
    if (this.sink && !this.sink.isWriteIndeterminate()) {
      const row = this.sink.handle.db
        .prepare('SELECT run_id FROM orch_legacy_run WHERE ledger_run_id = ?')
        .get(ledgerRunId) as { run_id: string } | undefined
      if (row) {
        this.#ledgerToCanonical.set(ledgerRunId, row.run_id)
        return row.run_id
      }
    }
    return ledgerRunId
  }

  private failOpen(error: unknown): void {
    this.#failures += 1
    this.#failedOpen = true
    this.#onError?.(error)
  }

  private executeTimed(
    cmd: OrchestrationCommand,
    meta: {
      runId: string
      ledgerRunId: string
      commitKind: string
      preFirstToken: boolean
      hookStarted: number
      bodyBytes?: number
      legacyLedgerSeq?: number
      legacyRunMapping?: { ledgerRunId: string; runId: string }
    }
  ): boolean {
    if (!this.sink || this.#failedOpen) return false
    if (this.sink.isWriteIndeterminate()) {
      this.failOpen(new Error('orchestration_write_indeterminate'))
      return false
    }
    let effectiveSeq = meta.legacyLedgerSeq
    if (this.#deferringLegacyWatermark && effectiveSeq !== undefined) {
      this.#maxDeferredSeq = Math.max(this.#maxDeferredSeq, effectiveSeq)
      effectiveSeq = undefined
    }
    const sinkStarted = performance.now()
    const result = this.sink.execute(cmd, {
      ...(effectiveSeq !== undefined ? { legacyLedgerSeq: effectiveSeq } : {}),
      ...(meta.legacyRunMapping ? { legacyRunMapping: meta.legacyRunMapping } : {})
    })
    const ended = performance.now()
    const sinkDurationMs = Number((ended - sinkStarted).toFixed(3))
    const durationMs = Number((ended - meta.hookStarted).toFixed(3))

    if (
      this.sink.isWriteIndeterminate() ||
      (result.kind === 'rejected' && result.reason === 'orchestration_write_indeterminate')
    ) {
      this.failOpen(new Error('orchestration_write_indeterminate'))
      return false
    }

    if (result.kind === 'duplicate') {
      this.#duplicates += 1
      return false
    }

    if (result.kind === 'rejected') {
      if (result.sticky) this.#rejectedSticky += 1
      else this.#rejectedRetryable += 1
      return false
    }

    // Only accepted commits enter commit counts and timing samples.
    // durationMs covers the entire projection hook (parse, ordinal, hash, EventSink).
    this.#acceptedCommits += 1
    if (meta.preFirstToken) {
      this.#preFirstTokenCommits.set(meta.runId, (this.#preFirstTokenCommits.get(meta.runId) ?? 0) + 1)
      this.#preFirstTokenMs.set(
        meta.runId,
        Number(((this.#preFirstTokenMs.get(meta.runId) ?? 0) + durationMs).toFixed(3))
      )
    }
    this.#onCommitTiming?.({
      runId: meta.runId,
      ledgerRunId: meta.ledgerRunId,
      commitKind: meta.commitKind,
      durationMs,
      sinkDurationMs,
      preFirstToken: meta.preFirstToken,
      ...(meta.bodyBytes !== undefined ? { bodyBytes: meta.bodyBytes } : {})
    })
    return true
  }

  /** Flushes deferred >16 KiB bodies to `BodyStore` off the pre-first-token hot path. */
  flushPendingBodies(runId?: string): void {
    if (!this.sink || this.#failedOpen || this.sink.isWriteIndeterminate()) {
      if (runId) this.#pendingBodies.delete(runId)
      else this.#pendingBodies.clear()
      return
    }
    const keys = runId !== undefined ? (this.#pendingBodies.has(runId) ? [runId] : []) : [...this.#pendingBodies.keys()]
    for (const key of keys) {
      const entry = this.#pendingBodies.get(key)
      this.#pendingBodies.delete(key)
      if (!entry) continue
      // Never resurrect an external body file after its run/session was deleted.
      if (!this.sink.getRun(key)) continue
      try {
        this.sink.bodyStore.prepareBody(entry.content)
      } catch (error) {
        this.failOpen(error)
        return
      }
    }
  }

  /** Projects ledger lifecycle transitions into `orchestration.db`. */
  onLedgerEvent(event: LedgerEvent, meta?: LedgerEventMeta): void {
    if (!this.sink || this.#failedOpen) return
    const hookStarted = performance.now()
    try {
      if (event.kind === 'intent_recorded') {
        const routing = parseLedgerIntentRouting(event.runId, event.detail)
        this.#ledgerToCanonical.set(event.runId, routing.canonicalRunId)
        const commandId = event.intentId ?? `legacy-intent:${event.runId}`
        const runMeta = meta ?? this.#resolveRunMeta?.(event.runId)
        const peerActor =
          runMeta?.peerCertSHA256 && PEER_SHA_RE.test(runMeta.peerCertSHA256)
            ? `peer:${runMeta.peerCertSHA256}`
            : 'system'
        if (peerActor.startsWith('peer:')) this.sink.authorizeActor(peerActor)
        const scope: 'local' | 'remote' = runMeta?.grantScope === 'local' ? 'local' : 'remote'
        const ordinal = routing.sessionKey
          ? (routing.ordinal ??
            (routing.isConversationRun
              ? this.#resolveTurnOrdinal(routing.sessionKey, routing.canonicalRunId)
              : undefined) ??
            this.sink.getNextTurnOrdinal(routing.sessionKey))
          : undefined
        const detailBytes = event.detail ? Buffer.byteLength(event.detail, 'utf8') : 0
        // Defer >16 KiB external body file write + fsync off the pre-first-token path (shadow never
        // dispatches from BodyStore; content is hashed in memory now and persisted on terminal/close).
        // Only queue after the commit is accepted so rejected submits never leave orphan body files.
        const body =
          event.detail && detailBytes > INLINE_BODY_MAX_BYTES
            ? { storage: 'external' as const, sha256: sha256Hex(event.detail), bytes: detailBytes }
            : undefined
        const payload = {
          runId: routing.canonicalRunId,
          sessionKey: routing.sessionKey,
          ...(ordinal !== undefined ? { ordinal } : {}),
          provider: routing.provider,
          profile: routing.profile,
          cwd: routing.cwd,
          ...(routing.promptPreview !== undefined ? { promptPreview: routing.promptPreview } : {}),
          ...(routing.userTextPreview !== undefined ? { userTextPreview: routing.userTextPreview } : {}),
          ...(body ? { body } : {}),
          claimMode: 'immediate' as const,
          leaseOwner: this.#leaseOwner,
          origin: scope,
          isConversationRun: routing.isConversationRun,
          shadowOnly: true
        }
        const accepted = this.executeTimed(
          {
            type: 'run.submit',
            commandId,
            actor: peerActor,
            scope,
            at: event.at,
            payload,
            payloadSha256: sha256Hex(canonicalJson(payload))
          },
          {
            runId: routing.canonicalRunId,
            ledgerRunId: event.runId,
            commitKind: 'intent_recorded',
            preFirstToken: true,
            hookStarted,
            bodyBytes: detailBytes,
            legacyLedgerSeq: event.seq,
            legacyRunMapping: { ledgerRunId: event.runId, runId: routing.canonicalRunId }
          }
        )
        if (accepted && body && event.detail) {
          this.#pendingBodies.delete(routing.canonicalRunId)
          this.#pendingBodies.set(routing.canonicalRunId, { sha256: body.sha256, content: event.detail })
          if (this.#pendingBodies.size > MAX_PENDING_BODIES) {
            const oldestKey = this.#pendingBodies.keys().next().value
            if (oldestKey && oldestKey !== routing.canonicalRunId) {
              setImmediate(() => this.flushPendingBodies(oldestKey))
            }
          }
        }
        return
      }

      const runId = this.resolveCanonicalRunId(event.runId)
      if (event.kind === 'run_dispatched') {
        const payload = { runId, step: 'admitted_and_dispatched' as const }
        this.executeTimed(
          {
            type: 'run.effect_result',
            commandId: `effect:h1-${event.runId}:admitted_and_dispatched`,
            actor: `effect:h1-${event.runId}`,
            scope: 'system',
            at: event.at,
            payload,
            payloadSha256: sha256Hex(canonicalJson(payload))
          },
          {
            runId,
            ledgerRunId: event.runId,
            commitKind: 'admitted_and_dispatched',
            preFirstToken: true,
            hookStarted,
            legacyLedgerSeq: event.seq
          }
        )
        return
      }

      if (event.kind === 'run_progress') {
        this.handleProgressMarker(event, runId, hookStarted, meta)
        return
      }

      const step =
        event.kind === 'run_settled' ? 'settled' : event.kind === 'run_failed' ? 'failed' : 'cancelled'
      const payload = {
        runId,
        step: step as 'settled' | 'failed' | 'cancelled',
        ...(event.detail ? { reason: event.detail } : {}),
        outcome: {
          status: 'available' as const,
          quality: 'exact' as const,
          source: [`legacy-ledger:${event.seq}`],
          value: step
        },
        evidence: [`legacy-ledger:${event.seq}`]
      }
      this.executeTimed(
        {
          type: 'run.effect_result',
          commandId: `effect:h1-${event.runId}:${step}`,
          actor: `effect:h1-${event.runId}`,
          scope: 'system',
          at: event.at,
          payload,
          payloadSha256: sha256Hex(canonicalJson(payload))
        },
        {
          runId,
          ledgerRunId: event.runId,
          commitKind: step,
          preFirstToken: false,
          hookStarted,
          legacyLedgerSeq: event.seq
        }
      )
      this.flushPendingBodies(runId)
    } catch (error) {
      this.failOpen(error)
    }
  }

  private handleProgressMarker(
    event: LedgerEvent,
    runId: string,
    hookStarted: number,
    meta?: LedgerEventMeta
  ): void {
    const built = buildProgressMarkerCommand(event, runId, meta)
    if (!built) return
    if (built.authorizePeer) this.sink!.authorizeActor(built.authorizePeer)
    this.executeTimed(built.command, {
      runId,
      ledgerRunId: event.runId,
      commitKind: built.commitKind,
      preFirstToken: false,
      hookStarted,
      legacyLedgerSeq: event.seq
    })
  }

  /**
   * Projects `ConversationStore.settle` into `orchestration.db`: compares the authoritative
   * ordinal against the projected turn's ordinal (counting any mismatch as a deviation
   * without fencing), and commits `turn.record_delivery` through `EventSink.execute(...)`.
   */
  onConversationTurnSettled(info: ConversationTurnSettledInfo): void {
    if (!this.sink || this.#failedOpen) return
    const hookStarted = performance.now()
    try {
      const turn = info.conversation.turns.find((candidate) => candidate.runId === info.runId)
      if (!turn) return
      if (this.sink.isWriteIndeterminate()) {
        this.failOpen(new Error('orchestration_write_indeterminate'))
        return
      }
      const existingTurn = this.sink.getTurnByRunId(info.runId)
      if (existingTurn && existingTurn.ordinal !== turn.ordinal) {
        this.#ordinalMismatches += 1
        return
      }
      if (!existingTurn) {
        const occupant = this.sink.getTurn(info.conversationId, turn.ordinal)
        if (occupant && occupant.runId !== info.runId) {
          this.#ordinalMismatches += 1
          return
        }
      }

      const at = this.#clock()
      const delivery = info.delivery.status
      const outcome =
        info.delivery.status === 'accepted'
          ? {
              status: 'available' as const,
              quality: 'exact' as const,
              source: [`conversation:${info.conversationId}`],
              value: info.delivery.outcome
            }
          : {
              status: 'unavailable' as const,
              quality: 'unavailable' as const,
              source: [`conversation:${info.conversationId}`],
              omissionReason: info.delivery.reason
            }
      const payload = {
        sessionKey: info.conversationId,
        runId: info.runId,
        ordinal: turn.ordinal,
        delivery,
        outcome,
        ...(info.delivery.status !== 'accepted' ? { reason: info.delivery.reason } : {}),
        settledAt: at,
        evidence: [`conversation:${info.conversationId}`]
      }
      const payloadSha256 = sha256Hex(canonicalJson(payload))
      this.executeTimed(
        {
          type: 'turn.record_delivery',
          commandId: `effect:h3-${info.conversationId}-${info.runId}:${delivery}`,
          actor: `effect:h3-${info.conversationId}`,
          scope: 'system',
          at,
          payload,
          payloadSha256
        },
        {
          runId: info.runId,
          ledgerRunId: info.runId,
          commitKind: 'turn_settled',
          preFirstToken: false,
          hookStarted
        }
      )
    } catch (error) {
      this.failOpen(error)
    }
  }

  close(): void {
    try {
      this.flushPendingBodies()
      this.sink?.close()
    } catch {
      // Ignore close errors in shadow mode.
    }
  }
}
