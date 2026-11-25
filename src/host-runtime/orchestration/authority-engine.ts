import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../../main/run-registry'
import {
  answerQuestionWithSink,
  recordProgressWithSink,
  recordTerminalWithSink,
  resolveIntentWithSink,
  stopRunWithSink
} from './authority-commands'
import {
  buildSubmitCommandForAuthority,
  getRunStartExpiryInfo,
  h1DetailDigest,
  runAuthorityPreDispatchRecheck,
  tryRealpath,
  type AuthorityBeforeDispatchInput,
  type AuthoritySubmitInput
} from './authority-dispatch'
import { canonicalJson, sha256Hex } from './canonical-json'
import type { EventSink } from './event-sink'
import type { Evidence } from '../../shared/turn-record-contracts'
import { findNativeSession, scopedNativeSessionKey } from './native-session-lookup'
import { parseLedgerIntentRouting, type ShadowCommitSample } from './shadow-routing'
import {
  DEFAULT_PENDING_TTL_MS,
  INLINE_BODY_MAX_BYTES,
  LOCAL_USER_ACTOR,
  OrchestrationStoreError,
  type PreparedBody
} from './types'

export type { AuthorityBeforeDispatchInput, AuthoritySubmitInput } from './authority-dispatch'

const PEER_SHA_RE = /^[0-9a-f]{64}$/

export interface AuthorityEngineOptions {
  sink: EventSink
  leaseOwner?: string
  pendingTtlMs?: number
  clock?: () => number
  resolveTurnOrdinal?: (sessionKey: string, runId: string) => number | undefined
  onCommitTiming?: (sample: ShadowCommitSample) => void
}

export type AuthoritySubmitResult =
  | { kind: 'accepted'; runId: string; seq: number }
  | { kind: 'duplicate'; runId: string; seq: number }
  | { kind: 'rejected'; reason: string; sticky: boolean }

export type AuthorityBeforeDispatchResult =
  | { ok: true }
  | { ok: false; action: 'fail'; reason: string }
  | { ok: false; action: 'requeue'; reason: string; retryAfterMs?: number }

/**
 * Authoritative orchestration engine.
 */
export class AuthorityEngine {
  readonly sink: EventSink
  readonly #leaseOwner: string
  readonly #pendingTtlMs: number
  readonly #clock: () => number
  readonly #resolveTurnOrdinal?: (sessionKey: string, runId: string) => number | undefined
  readonly #onCommitTiming?: (sample: ShadowCommitSample) => void
  readonly #preparedRealCwdByRun = new Map<string, string>()
  readonly #preDispatchedRuns = new Set<string>()

  constructor(options: AuthorityEngineOptions) {
    this.sink = options.sink
    this.#leaseOwner = options.leaseOwner ?? `daemon:${process.pid}`
    this.#pendingTtlMs = Math.min(Math.max(1, options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS), DEFAULT_PENDING_TTL_MS)
    this.#clock = options.clock ?? (() => Date.now())
    this.#resolveTurnOrdinal = options.resolveTurnOrdinal
    this.#onCommitTiming = options.onCommitTiming
  }

  private actorForPeer(peerCertSHA256?: string): string {
    if (peerCertSHA256 && PEER_SHA_RE.test(peerCertSHA256)) {
      const actor = `peer:${peerCertSHA256}`
      this.sink.authorizeActor(actor)
      return actor
    }
    // R13: a local caller is the user, so its receipt must not expire as an internal system one.
    return LOCAL_USER_ACTOR
  }

  private checkLegacySystemReceipt(commandId: string, actor: string):
    { runId: string; seq: number; intentDigest?: string } | undefined {
    if (actor === 'system') return undefined
    const legacy = this.sink.getReceipt(commandId, 'system')
    if (legacy?.type !== 'run.submit' || legacy.status !== 'accepted') return undefined
    const runId = typeof legacy.result?.runId === 'string' ? legacy.result.runId : undefined
    const digest = legacy.result?.intentDetailSha256
    return runId ? {
      runId, seq: legacy.resultSeq ?? 0, intentDigest: typeof digest === 'string' ? digest : undefined
    } : undefined
  }

  private finishSubmit(
    built: ReturnType<typeof buildSubmitCommandForAuthority>,
    hookStarted: number,
    expectedSessionDeleteEpoch: number | undefined,
    bodyWriteMs?: number
  ): AuthoritySubmitResult {
    const sinkStarted = performance.now()
    const result = this.sink.execute(built.cmd, {
      requireExternalBodyDurable: true,
      ...(expectedSessionDeleteEpoch !== undefined ? { expectedSessionDeleteEpoch } : {})
    })
    const ended = performance.now()
    if (result.kind === 'duplicate') {
      const dupRunId = typeof result.receipt.result?.runId === 'string' ? result.receipt.result.runId : built.runId
      return { kind: 'duplicate', runId: dupRunId, seq: result.receipt.resultSeq ?? 0 }
    }
    if (result.kind === 'rejected') {
      return { kind: 'rejected', reason: result.reason, sticky: result.sticky }
    }
    if (built.preparedRealCwd) this.#preparedRealCwdByRun.set(built.runId, built.preparedRealCwd)
    const merged = built.cmd.payload.dispatchImmediately === true
    if (merged) this.#preDispatchedRuns.add(built.runId)
    this.#onCommitTiming?.({
      runId: built.runId,
      ledgerRunId: built.runId,
      commitKind: merged ? 'intent_and_dispatched' : 'intent_recorded',
      durationMs: Number((ended - hookStarted).toFixed(3)),
      sinkDurationMs: Number((ended - sinkStarted).toFixed(3)),
      ...(bodyWriteMs !== undefined ? { bodyWriteMs: Number(bodyWriteMs.toFixed(3)) } : {}),
      preFirstToken: true,
      bodyBytes: built.detailBytes
    })
    return { kind: 'accepted', runId: built.runId, seq: result.receipt.resultSeq ?? 0 }
  }

  private submitBuilt(
    input: AuthoritySubmitInput,
    actor: string,
    hookStarted: number,
    sessionKey: string | null,
    epochBeforePrepare: number | undefined,
    preparedBody: PreparedBody | undefined,
    bodyWriteMs: number | undefined
  ): AuthoritySubmitResult {
    const built = buildSubmitCommandForAuthority({
      sink: this.sink,
      actor,
      leaseOwner: this.#leaseOwner,
      pendingTtlMs: this.#pendingTtlMs,
      now: this.#clock(),
      resolveTurnOrdinal: this.#resolveTurnOrdinal,
      sessionKey,
      input,
      preparedBody
    })
    return this.finishSubmit(built, hookStarted, epochBeforePrepare, bodyWriteMs)
  }

  private beginSubmit(input: AuthoritySubmitInput):
    | { early: AuthoritySubmitResult }
    | { actor: string; hookStarted: number; sessionKey: string | null; epochBeforePrepare: number | undefined } {
    if (this.sink.isWriteIndeterminate()) {
      return { early: { kind: 'rejected', reason: 'orchestration_write_indeterminate', sticky: false } }
    }
    const hookStarted = performance.now()
    const actor = this.actorForPeer(input.peerCertSHA256)
    const legacyDup = this.checkLegacySystemReceipt(input.commandId, actor)
    if (legacyDup) {
      if (legacyDup.intentDigest !== h1DetailDigest(input.detail)) {
        return { early: { kind: 'rejected', reason: 'command_payload_conflict', sticky: true } }
      }
      return { early: { kind: 'duplicate', runId: legacyDup.runId, seq: legacyDup.seq } }
    }
    const preview = parseLedgerIntentRouting(input.runId ?? 'probe', input.detail)
    let sessionKey = preview.sessionKey
    if (sessionKey && !preview.isConversationRun) {
      const identity = {
        sessionId: sessionKey, provider: preview.provider, profile: preview.profile,
        cwd: tryRealpath(preview.cwd) ?? preview.cwd
      }
      const session = findNativeSession(this.sink, identity)
      sessionKey = session?.sessionKey ?? (this.sink.getSession(sessionKey) ? scopedNativeSessionKey(identity) : sessionKey)
    }
    const epochBeforePrepare = sessionKey ? this.sink.getSessionDeleteEpoch(sessionKey) : undefined
    return { actor, hookStarted, sessionKey, epochBeforePrepare }
  }

  /** Async authoritative submit: writes and fsyncs >16 KiB body BEFORE EventSink commit (data §4.7). */
  async submitAsync(input: AuthoritySubmitInput): Promise<AuthoritySubmitResult> {
    const start = this.beginSubmit(input)
    if ('early' in start) return start.early
    let preparedBody: PreparedBody | undefined
    let bodyWriteMs: number | undefined
    let unpinBody: (() => void) | undefined
    try {
      if (input.detail && Buffer.byteLength(input.detail, 'utf8') > INLINE_BODY_MAX_BYTES) {
        unpinBody = this.sink.bodyStore.pin(sha256Hex(Buffer.from(input.detail, 'utf8')))
        const bodyStart = performance.now()
        preparedBody = await this.sink.bodyStore.prepareBodyAsync(input.detail)
        bodyWriteMs = performance.now() - bodyStart
      }
      return this.submitBuilt(input, start.actor, start.hookStarted, start.sessionKey, start.epochBeforePrepare, preparedBody, bodyWriteMs)
    } finally {
      unpinBody?.()
    }
  }

  /** Synchronous authoritative submit for non-attachment local/conversation submit path. */
  submitSync(input: AuthoritySubmitInput): AuthoritySubmitResult {
    const start = this.beginSubmit(input)
    if ('early' in start) return start.early
    let preparedBody: PreparedBody | undefined
    let bodyWriteMs: number | undefined
    let unpinBody: (() => void) | undefined
    try {
      if (input.detail && Buffer.byteLength(input.detail, 'utf8') > INLINE_BODY_MAX_BYTES) {
        unpinBody = this.sink.bodyStore.pin(sha256Hex(Buffer.from(input.detail, 'utf8')))
        const bodyStart = performance.now()
        preparedBody = this.sink.bodyStore.prepareBody(input.detail)
        bodyWriteMs = performance.now() - bodyStart
      }
      return this.submitBuilt(input, start.actor, start.hookStarted, start.sessionKey, start.epochBeforePrepare, preparedBody, bodyWriteMs)
    } finally {
      unpinBody?.()
    }
  }

  beforeDispatch(input: AuthorityBeforeDispatchInput): AuthorityBeforeDispatchResult {
    if (this.sink.isWriteIndeterminate()) {
      throw new OrchestrationStoreError('orchestration_write_indeterminate')
    }
    const hookStarted = performance.now()
    const run = this.sink.getRun(input.runId)
    if (!run) return { ok: false, action: 'fail', reason: 'invalid_target' }
    const preDispatched = this.#preDispatchedRuns.delete(input.runId)
    if (run.stopState === 'requested') {
      this.recordTerminal({
        runId: input.runId,
        step: 'cancelled',
        reason: 'stop_requested',
        delivery: 'not_sent',
        evidence: ['host.stop_before_dispatch']
      })
      return { ok: false, action: 'fail', reason: 'stop_requested' }
    }
    if (preDispatched && run.lifecycle === 'dispatched') return { ok: true }
    // D1: a queued run is accepted and not yet dispatched — exactly what this gate admits. Without
    // `queued` here, the first time the session head cleared the queue entry failed the gate and the
    // row stayed `queued` forever, which then blocked every later send in that session.
    if (run.lifecycle !== 'recorded' && run.lifecycle !== 'queued') {
      return { ok: false, action: 'fail', reason: 'illegal_transition' }
    }

    const now = this.#clock()
    const { intentAt, expiresAt } = getRunStartExpiryInfo(this.sink, input.runId, run.intentSeq)
    // D1: a queued run waits as long as the head takes. The pending TTL bounds a dispatch nobody will
    // claim, so it must not be recomputed from the intent time here — that cancelled a queue entry the
    // moment the head cleared after more than a minute, which is exactly what the queue exists for.
    const effectiveExpiresAt = run.lifecycle === 'queued'
      ? null
      : expiresAt ?? (intentAt !== null ? intentAt + this.#pendingTtlMs : null)
    if ((intentAt !== null && now < intentAt) || (effectiveExpiresAt !== null && now > effectiveExpiresAt)) {
      this.recordTerminal({
        runId: input.runId,
        step: 'cancelled',
        reason: 'pending_expired',
        delivery: 'not_sent',
        evidence: ['pre_dispatch_recheck:pending_expired']
      })
      return { ok: false, action: 'fail', reason: 'pending_expired' }
    }

    const effectiveActor = run.ownerActor.startsWith('peer:') ? run.ownerActor : input.actor
    const preparedRealCwd = this.#preparedRealCwdByRun.get(input.runId) ?? tryRealpath(run.cwd)
    const recheck = runAuthorityPreDispatchRecheck({ ...input, actor: effectiveActor }, preparedRealCwd, run.cwd)
    if (!recheck.ok) {
      if (recheck.action === 'requeue') {
        const retryAfterMs =
          effectiveExpiresAt !== null ? Math.max(10, effectiveExpiresAt - now + 5) : this.#pendingTtlMs
        return { ok: false, action: 'requeue', reason: recheck.reason, retryAfterMs }
      }
      this.recordTerminal({
        runId: input.runId,
        step: 'failed',
        reason: recheck.reason,
        ...('detail' in recheck && recheck.detail ? { detail: recheck.detail } : {}),
        delivery: 'not_sent',
        evidence: [`pre_dispatch_recheck:${recheck.reason}`]
      })
      return recheck
    }

    const sinkStarted = performance.now()
    const payload = { runId: input.runId, step: 'admitted_and_dispatched' as const }
    const res = this.sink.execute({
      type: 'run.effect_result',
      commandId: `effect:p4-${input.runId}:admitted_and_dispatched`,
      actor: `effect:p4-${input.runId}`,
      scope: 'system',
      at: this.#clock(),
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
    const ended = performance.now()
    if (res.kind === 'rejected') return { ok: false, action: 'fail', reason: res.reason }
    if (res.kind === 'accepted') {
      this.#onCommitTiming?.({
        runId: input.runId,
        ledgerRunId: input.runId,
        commitKind: 'admitted_and_dispatched',
        durationMs: Number((ended - hookStarted).toFixed(3)),
        sinkDurationMs: Number((ended - sinkStarted).toFixed(3)),
        preFirstToken: true
      })
    }
    return { ok: true }
  }

  /** Write command writing a permanent `resolved_absent` tombstone if the intent never existed. */
  resolveIntent(input: {
    peerCertSHA256?: string
    grantScope: 'local' | 'remote'
    commandId: string
  }): { runId: string; state: 'recorded' | 'dispatched' | 'settled' | 'failed' | 'cancelled' } {
    return resolveIntentWithSink({
      sink: this.sink,
      actor: this.actorForPeer(input.peerCertSHA256),
      clock: this.#clock,
      checkLegacySystemReceipt: (cmdId, actor) => this.checkLegacySystemReceipt(cmdId, actor),
      input
    })
  }

  /** Tightening-only stop (core §2.5 + R5): always stops live runs even during storage fence. */
  stopRun<State extends RunRegistryState, Control extends RunRegistryControl>(input: {
    peerCertSHA256?: string
    grantScope: 'local' | 'remote'
    runId: string
    registry?: RunRegistry<State, Control>
    stopControl?: (control: Control) => void
    abortLive?: () => boolean
    reason?: string
  }): { status: 'requested' | 'already_requested' | 'not_running' } {
    return stopRunWithSink({
      sink: this.sink,
      actor: this.actorForPeer(input.peerCertSHA256),
      clock: this.#clock,
      input
    })
  }

  answerQuestion(input: {
    peerCertSHA256?: string
    grantScope: 'local' | 'remote'
    runId: string
    questionId: string
    answerId: string
    answerSha256: string
    answerPayload: Record<string, unknown>
  }) {
    return answerQuestionWithSink({
      sink: this.sink,
      actor: this.actorForPeer(input.peerCertSHA256),
      clock: this.#clock,
      input
    })
  }

  recordProgress(input: {
    runId: string
    step: 'session_bound' | 'question_opened' | 'question_closed' | 'content_gap' | 'provider_settled' | 'finalized'
    commandSuffix: string
    nativeSessionId?: string
    attachNative?: true
    catalogRunId?: string
    questionId?: string
    questionKind?: string
    reason?: string
    outputSeq?: number
    contentRef?: string
    isError?: boolean
    evidence?: string[]
  }): void {
    recordProgressWithSink(this.sink, this.#clock, input)
  }

  compensateSubmitFailure(runId: string, reason: string): void {
    this.#preDispatchedRuns.delete(runId)
    if (this.sink.isWriteIndeterminate()) return
    const run = this.sink.getRun(runId)
    if (!run || (run.lifecycle !== 'recorded' && run.lifecycle !== 'dispatched')) return
    this.recordTerminal({
      runId,
      step: 'cancelled',
      reason,
      delivery: 'not_sent',
      evidence: ['host.submit_compensation']
    })
  }

  recordTerminal(input: {
    runId: string
    appRunId?: string
    step: 'settled' | 'failed' | 'cancelled' | 'interrupted'
    reason?: string
    detail?: string
    delivery?: 'accepted' | 'not_sent' | 'unknown'
    evidence?: string[]
    outcome?: Evidence<string>
  }): void {
    this.#preDispatchedRuns.delete(input.runId)
    this.#preparedRealCwdByRun.delete(input.runId)
    recordTerminalWithSink(this.sink, this.#clock, input)
  }
}
