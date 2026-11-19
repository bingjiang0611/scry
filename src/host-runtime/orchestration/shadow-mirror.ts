import type { Conversation, ConversationDelivery } from '../../shared/conversation'
import type { LedgerEvent } from '../../main/remote/session-ledger'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink, type EventSinkOptions } from './event-sink'
import type { OrchestrationCommand } from './orchestrator-commands'

export interface ShadowCommitSample {
  runId: string
  ledgerRunId: string
  commitKind: string
  durationMs: number
  preFirstToken: boolean
}

export interface ShadowMirrorOptions extends EventSinkOptions {
  leaseOwner?: string
  clock?: () => number
  /** Optional resolver returning the submitting peer cert SHA-256 and grant scope for a ledger run. */
  resolveRunMeta?: (ledgerRunId: string) => { peerCertSHA256?: string; grantScope?: 'local' | 'remote' } | undefined
  onCommitTiming?: (sample: ShadowCommitSample) => void
  onError?: (error: unknown) => void
}

export interface ShadowMirrorStats {
  acceptedCommits: number
  /** Alias for acceptedCommits (only accepted commits, never rejected no-ops). */
  commits: number
  duplicates: number
  rejectedSticky: number
  rejectedRetryable: number
  failures: number
  /** Total shadow parity anomalies: sticky rejections + retryable rejections + failures. */
  deviations: number
  failedOpen: boolean
  preFirstTokenCommitsByRun: ReadonlyMap<string, number>
  preFirstTokenDurationMsByRun: ReadonlyMap<string, number>
}

export interface ConversationTurnSettledInfo {
  conversationId: string
  runId: string
  conversation: Conversation
  delivery: Exclude<ConversationDelivery, { status: 'pending' }>
}

export interface ParsedIntentRouting {
  provider: string
  profile: string | null
  cwd: string
  promptPreview?: string
  sessionKey: string | null
  canonicalRunId: string
  isConversationRun: boolean
  ordinal?: number
}

export function parseLedgerIntentRouting(ledgerRunId: string, detail: string | undefined): ParsedIntentRouting {
  let provider = 'unknown'
  let profile: string | null = null
  let cwd = ''
  let promptPreview: string | undefined
  let sessionKey: string | null = null
  let canonicalRunId = ledgerRunId
  let isConversationRun = false
  let ordinal: number | undefined

  if (detail) {
    try {
      const parsed = JSON.parse(detail) as Record<string, unknown>
      if (typeof parsed.providerId === 'string' && parsed.providerId.length > 0) provider = parsed.providerId
      else if (typeof parsed.provider === 'string' && parsed.provider.length > 0) provider = parsed.provider
      if (typeof parsed.agentProfileId === 'string') profile = parsed.agentProfileId
      else if (typeof parsed.profile === 'string') profile = parsed.profile
      if (typeof parsed.cwd === 'string') cwd = parsed.cwd
      if (typeof parsed.prompt === 'string') promptPreview = parsed.prompt
      const conv = parsed.conversation as { conversationId?: unknown; runId?: unknown; ordinal?: unknown } | undefined
      if (conv && typeof conv === 'object') {
        if (typeof conv.conversationId === 'string' && conv.conversationId.length > 0) {
          sessionKey = conv.conversationId
          isConversationRun = true
        }
        if (typeof conv.runId === 'string' && conv.runId.length > 0) {
          canonicalRunId = conv.runId
        }
        if (typeof conv.ordinal === 'number' && Number.isSafeInteger(conv.ordinal) && conv.ordinal >= 1) {
          ordinal = conv.ordinal
        }
      } else if (typeof parsed.resume === 'string' && parsed.resume.length > 0) {
        sessionKey = parsed.resume
      }
    } catch {
      // Malformed routing detail is still recorded with defaults so shadow parity never throws.
    }
  }

  return { provider, profile, cwd, promptPreview, sessionKey, canonicalRunId, isConversationRun, ordinal }
}

const PEER_SHA_RE = /^[0-9a-f]{64}$/

/**
 * P4-1 fail-open shadow mirror (plan §9 P4-1).
 * Mirrors H1 `SessionLedger.#emit` and H3 `ConversationStore.settle` into `orchestration.db`
 * strictly through `EventSink.execute(...)` without altering any user-visible run behavior.
 */
export class ShadowMirror {
  readonly sink: EventSink | null
  readonly #leaseOwner: string
  readonly #clock: () => number
  readonly #resolveRunMeta?: ShadowMirrorOptions['resolveRunMeta']
  readonly #onCommitTiming?: (sample: ShadowCommitSample) => void
  readonly #onError?: (error: unknown) => void
  readonly #ledgerToCanonical = new Map<string, string>()
  readonly #preFirstTokenCommits = new Map<string, number>()
  readonly #preFirstTokenMs = new Map<string, number>()
  #acceptedCommits = 0
  #duplicates = 0
  #rejectedSticky = 0
  #rejectedRetryable = 0
  #failures = 0
  #failedOpen = false

  private constructor(sink: EventSink | null, options: ShadowMirrorOptions) {
    this.sink = sink
    this.#leaseOwner = options.leaseOwner ?? `daemon:${process.pid}`
    this.#clock = options.clock ?? (() => Date.now())
    this.#resolveRunMeta = options.resolveRunMeta
    this.#onCommitTiming = options.onCommitTiming
    this.#onError = options.onError
    if (!sink) {
      this.#failures = 1
      this.#failedOpen = true
    }
  }

  static open(options: ShadowMirrorOptions): ShadowMirror {
    try {
      const sink = EventSink.open({
        ...options,
        maxActiveRuns: options.maxActiveRuns ?? 1024
      })
      return new ShadowMirror(sink, options)
    } catch (error) {
      options.onError?.(error)
      return new ShadowMirror(null, options)
    }
  }

  stats(): ShadowMirrorStats {
    return {
      acceptedCommits: this.#acceptedCommits,
      commits: this.#acceptedCommits,
      duplicates: this.#duplicates,
      rejectedSticky: this.#rejectedSticky,
      rejectedRetryable: this.#rejectedRetryable,
      failures: this.#failures,
      deviations: this.#rejectedSticky + this.#rejectedRetryable + this.#failures,
      failedOpen: this.#failedOpen,
      preFirstTokenCommitsByRun: this.#preFirstTokenCommits,
      preFirstTokenDurationMsByRun: this.#preFirstTokenMs
    }
  }

  /** Marks shadow as failed-open (e.g. when startup import trips the sink fence). */
  markFailedOpen(error: unknown): void {
    this.failOpen(error)
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
      legacyLedgerSeq?: number
      legacyRunMapping?: { ledgerRunId: string; runId: string }
    }
  ): void {
    if (!this.sink || this.#failedOpen) return
    if (this.sink.isWriteIndeterminate()) {
      this.failOpen(new Error('orchestration_write_indeterminate'))
      return
    }
    const started = performance.now()
    const result = this.sink.execute(cmd, {
      ...(meta.legacyLedgerSeq !== undefined ? { legacyLedgerSeq: meta.legacyLedgerSeq } : {}),
      ...(meta.legacyRunMapping ? { legacyRunMapping: meta.legacyRunMapping } : {})
    })
    const durationMs = Number((performance.now() - started).toFixed(3))

    if (this.sink.isWriteIndeterminate() || (result.kind === 'rejected' && result.reason === 'orchestration_write_indeterminate')) {
      this.failOpen(new Error('orchestration_write_indeterminate'))
      return
    }

    if (result.kind === 'duplicate') {
      this.#duplicates += 1
      return
    }

    if (result.kind === 'rejected') {
      if (result.sticky) this.#rejectedSticky += 1
      else this.#rejectedRetryable += 1
      return
    }

    // Only accepted commits enter commit counts and timing samples (B2).
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
      preFirstToken: meta.preFirstToken
    })
  }

  /** H1 `#emit` shadow hook: mirrors ledger lifecycle transitions into `orchestration.db`. */
  onLedgerEvent(event: LedgerEvent): void {
    if (!this.sink || this.#failedOpen) return
    try {
      if (event.kind === 'intent_recorded') {
        const routing = parseLedgerIntentRouting(event.runId, event.detail)
        this.#ledgerToCanonical.set(event.runId, routing.canonicalRunId)
        const commandId = event.intentId ?? `legacy-intent:${event.runId}`
        const runMeta = this.#resolveRunMeta?.(event.runId)
        const peerActor =
          runMeta?.peerCertSHA256 && PEER_SHA_RE.test(runMeta.peerCertSHA256)
            ? `peer:${runMeta.peerCertSHA256}`
            : 'system'
        if (peerActor.startsWith('peer:')) this.sink.authorizeActor(peerActor)
        const scope: 'local' | 'remote' = runMeta?.grantScope === 'local' ? 'local' : 'remote'
        const ordinal = routing.sessionKey
          ? (routing.ordinal ?? this.sink.getNextTurnOrdinal(routing.sessionKey))
          : undefined
        const payload = {
          runId: routing.canonicalRunId,
          sessionKey: routing.sessionKey,
          ...(ordinal !== undefined ? { ordinal } : {}),
          provider: routing.provider,
          profile: routing.profile,
          cwd: routing.cwd,
          ...(routing.promptPreview !== undefined ? { promptPreview: routing.promptPreview } : {}),
          claimMode: 'immediate' as const,
          leaseOwner: this.#leaseOwner,
          origin: scope,
          isConversationRun: routing.isConversationRun,
          shadowOnly: true
        }
        this.executeTimed(
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
            legacyLedgerSeq: event.seq,
            legacyRunMapping: { ledgerRunId: event.runId, runId: routing.canonicalRunId }
          }
        )
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
            legacyLedgerSeq: event.seq
          }
        )
        return
      }

      if (event.kind === 'run_progress') {
        this.handleProgressMarker(event, runId)
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
          legacyLedgerSeq: event.seq
        }
      )
    } catch (error) {
      this.failOpen(error)
    }
  }

  private handleProgressMarker(event: LedgerEvent, runId: string): void {
    if (!event.detail) return
    let marker: Record<string, unknown>
    try {
      marker = JSON.parse(event.detail) as Record<string, unknown>
    } catch {
      return
    }
    const kind = marker.event
    if (kind === 'session' && typeof marker.externalSessionId === 'string') {
      const payload = { runId, step: 'session_bound' as const, nativeSessionId: marker.externalSessionId }
      this.executeTimed(
        {
          type: 'run.effect_result',
          commandId: `effect:h1-${event.runId}:session:${event.seq}`,
          actor: `effect:h1-${event.runId}`,
          scope: 'system',
          at: event.at,
          payload,
          payloadSha256: sha256Hex(canonicalJson(payload))
        },
        {
          runId,
          ledgerRunId: event.runId,
          commitKind: 'session_bound',
          preFirstToken: false,
          legacyLedgerSeq: event.seq
        }
      )
      return
    }
    if (kind === 'question_opened' && typeof marker.questionId === 'string') {
      const payload = {
        runId,
        step: 'question_opened' as const,
        questionId: marker.questionId,
        questionKind: typeof marker.kind === 'string' ? marker.kind : 'clarification',
        questionSource: typeof marker.source === 'string' ? marker.source : 'unknown'
      }
      this.executeTimed(
        {
          type: 'run.effect_result',
          commandId: `effect:h1-${event.runId}:qopen:${marker.questionId}:${event.seq}`,
          actor: `effect:h1-${event.runId}`,
          scope: 'system',
          at: event.at,
          payload,
          payloadSha256: sha256Hex(canonicalJson(payload))
        },
        {
          runId,
          ledgerRunId: event.runId,
          commitKind: 'question_opened',
          preFirstToken: false,
          legacyLedgerSeq: event.seq
        }
      )
      return
    }
    if (kind === 'question_answered' && typeof marker.questionId === 'string') {
      const answerId = typeof marker.answerId === 'string' ? marker.answerId : `ans-${event.seq}`
      const payload = {
        runId,
        questionId: marker.questionId,
        answerId,
        answerSha256: sha256Hex(answerId)
      }
      this.executeTimed(
        {
          type: 'question.answer',
          commandId: `effect:h1-${event.runId}:qans:${marker.questionId}:${event.seq}`,
          actor: 'system',
          scope: 'system',
          at: event.at,
          payload,
          payloadSha256: sha256Hex(canonicalJson(payload))
        },
        {
          runId,
          ledgerRunId: event.runId,
          commitKind: 'question_answered',
          preFirstToken: false,
          legacyLedgerSeq: event.seq
        }
      )
      return
    }
    if (kind === 'question_closed' && typeof marker.questionId === 'string') {
      const payload = {
        runId,
        step: 'question_closed' as const,
        questionId: marker.questionId,
        reason: typeof marker.resolution === 'string' ? marker.resolution : 'closed'
      }
      this.executeTimed(
        {
          type: 'run.effect_result',
          commandId: `effect:h1-${event.runId}:qclose:${marker.questionId}:${event.seq}`,
          actor: `effect:h1-${event.runId}`,
          scope: 'system',
          at: event.at,
          payload,
          payloadSha256: sha256Hex(canonicalJson(payload))
        },
        {
          runId,
          ledgerRunId: event.runId,
          commitKind: 'question_closed',
          preFirstToken: false,
          legacyLedgerSeq: event.seq
        }
      )
    }
  }

  /**
   * H3 `ConversationStore.settle` shadow hook (B3): commits a `turn.record_delivery` command
   * through `EventSink.execute(...)` so events and projections stay atomic and replay-consistent.
   */
  onConversationTurnSettled(info: ConversationTurnSettledInfo): void {
    if (!this.sink || this.#failedOpen) return
    try {
      const turn = info.conversation.turns.find((candidate) => candidate.runId === info.runId)
      if (!turn) return
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
          preFirstToken: false
        }
      )
    } catch (error) {
      this.failOpen(error)
    }
  }

  close(): void {
    try {
      this.sink?.close()
    } catch {
      // Ignore close errors in shadow mode.
    }
  }
}
