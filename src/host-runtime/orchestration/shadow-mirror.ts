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
  onCommitTiming?: (sample: ShadowCommitSample) => void
  onError?: (error: unknown) => void
}

export interface ShadowMirrorStats {
  failures: number
  failedOpen: boolean
  commits: number
  preFirstTokenCommitsByRun: ReadonlyMap<string, number>
  preFirstTokenDurationMsByRun: ReadonlyMap<string, number>
}

export interface ConversationTurnSettledInfo {
  conversationId: string
  runId: string
  conversation: Conversation
  delivery: Exclude<ConversationDelivery, { status: 'pending' }>
}

interface ParsedIntentRouting {
  provider: string
  profile: string | null
  cwd: string
  promptPreview?: string
  sessionKey: string | null
  canonicalRunId: string
  isConversationRun: boolean
}

export function parseLedgerIntentRouting(ledgerRunId: string, detail: string | undefined): ParsedIntentRouting {
  let provider = 'unknown'
  let profile: string | null = null
  let cwd = ''
  let promptPreview: string | undefined
  let sessionKey: string | null = null
  let canonicalRunId = ledgerRunId
  let isConversationRun = false

  if (detail) {
    try {
      const parsed = JSON.parse(detail) as Record<string, unknown>
      if (typeof parsed.providerId === 'string' && parsed.providerId.length > 0) provider = parsed.providerId
      else if (typeof parsed.provider === 'string' && parsed.provider.length > 0) provider = parsed.provider
      if (typeof parsed.agentProfileId === 'string') profile = parsed.agentProfileId
      else if (typeof parsed.profile === 'string') profile = parsed.profile
      if (typeof parsed.cwd === 'string') cwd = parsed.cwd
      if (typeof parsed.prompt === 'string') promptPreview = parsed.prompt
      const conv = parsed.conversation as { conversationId?: unknown; runId?: unknown } | undefined
      if (conv && typeof conv === 'object') {
        if (typeof conv.conversationId === 'string' && conv.conversationId.length > 0) {
          sessionKey = conv.conversationId
          isConversationRun = true
        }
        if (typeof conv.runId === 'string' && conv.runId.length > 0) {
          canonicalRunId = conv.runId
        }
      } else if (typeof parsed.resume === 'string' && parsed.resume.length > 0) {
        sessionKey = parsed.resume
      }
    } catch {
      // Malformed routing detail is still recorded with defaults so shadow parity never throws.
    }
  }

  return { provider, profile, cwd, promptPreview, sessionKey, canonicalRunId, isConversationRun }
}

/**
 * P4-1 fail-open shadow mirror (plan §9 P4-1).
 * Mirrors H1 `SessionLedger.#emit` and H3 `ConversationStore.settle` into `orchestration.db`
 * without altering any user-visible run behavior. Any storage error trips shadow fail-open,
 * increments the failure counter, and lets the live run proceed untouched.
 */
export class ShadowMirror {
  readonly sink: EventSink | null
  readonly #leaseOwner: string
  readonly #onCommitTiming?: (sample: ShadowCommitSample) => void
  readonly #onError?: (error: unknown) => void
  readonly #ledgerToCanonical = new Map<string, string>()
  readonly #preFirstTokenCommits = new Map<string, number>()
  readonly #preFirstTokenMs = new Map<string, number>()
  #failures = 0
  #failedOpen = false
  #commits = 0

  private constructor(sink: EventSink | null, options: ShadowMirrorOptions) {
    this.sink = sink
    this.#leaseOwner = options.leaseOwner ?? `daemon:${process.pid}`
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
      failures: this.#failures,
      failedOpen: this.#failedOpen,
      commits: this.#commits,
      preFirstTokenCommitsByRun: this.#preFirstTokenCommits,
      preFirstTokenDurationMsByRun: this.#preFirstTokenMs
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
      legacyLedgerSeq?: number
      legacyRunMapping?: { ledgerRunId: string; runId: string }
    }
  ): void {
    if (!this.sink || this.#failedOpen) return
    const started = performance.now()
    this.sink.execute(cmd, {
      ...(meta.legacyLedgerSeq !== undefined ? { legacyLedgerSeq: meta.legacyLedgerSeq } : {}),
      ...(meta.legacyRunMapping ? { legacyRunMapping: meta.legacyRunMapping } : {})
    })
    const durationMs = Number((performance.now() - started).toFixed(3))
    this.#commits += 1
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
        const payload = {
          runId: routing.canonicalRunId,
          sessionKey: routing.sessionKey,
          provider: routing.provider,
          profile: routing.profile,
          cwd: routing.cwd,
          ...(routing.promptPreview !== undefined ? { promptPreview: routing.promptPreview } : {}),
          claimMode: 'immediate' as const,
          leaseOwner: this.#leaseOwner,
          origin: 'remote' as const,
          isConversationRun: routing.isConversationRun
        }
        this.executeTimed(
          {
            type: 'run.submit',
            commandId,
            actor: 'system',
            scope: 'remote',
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

  /** H3 `ConversationStore.settle` shadow hook: mirrors settled turn delivery into `orch_p_turn`. */
  onConversationTurnSettled(info: ConversationTurnSettledInfo): void {
    if (!this.sink || this.#failedOpen) return
    try {
      const db = this.sink.handle.db
      const turn = info.conversation.turns.find((candidate) => candidate.runId === info.runId)
      if (!turn) return
      const now = Date.now()
      const delivery = info.delivery.status
      const outcome =
        info.delivery.status === 'accepted'
          ? {
              status: 'available',
              quality: 'exact',
              source: [`conversation:${info.conversationId}`],
              value: info.delivery.outcome
            }
          : {
              status: 'unavailable',
              quality: 'unavailable',
              source: [`conversation:${info.conversationId}`],
              omissionReason: info.delivery.reason
            }
      const existingTurn = db
        .prepare('SELECT 1 FROM orch_p_turn WHERE run_id = ?')
        .get(info.runId)
      if (existingTurn) {
        db.prepare(
          'UPDATE orch_p_turn SET delivery = ?, outcome = ?, settled_at = COALESCE(settled_at, ?) WHERE run_id = ?'
        ).run(delivery, canonicalJson(outcome), now, info.runId)
      } else {
        db.prepare(
          `INSERT OR IGNORE INTO orch_p_turn (
            session_key, ordinal, run_id, ordinal_origin, user_text_preview,
            delivery, outcome, started_at, settled_at, recovered_at,
            content_ref, evidence, rev_seq, author
          ) VALUES (?, ?, ?, 'native', NULL, ?, ?, ?, ?, NULL, NULL, NULL, 0, 'user')`
        ).run(info.conversationId, turn.ordinal, info.runId, delivery, canonicalJson(outcome), now, now)
      }
      this.sink.handle.enforceModes()
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
