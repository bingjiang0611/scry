import type { BackgroundServiceOrchestrationStatus } from '../shared/background-service'
import { maybeStartOrchestrationMaintenance } from './orchestration-maintenance'
import { createOutboxGate } from './orchestration-outbox-gate'
import { recordSessionLineage } from './orchestration-lineage'
import { runDeferredLegacyImport } from './orchestration-deferred-import'
import { recordSessionMetadata } from './orchestration-session-metadata'
import { createTransportHandlers } from './orchestration-transport-handlers'
import { observeAuthorityNativeTranscript } from './orchestration-native-transcript'
import type { ConversationStore } from '../main/conversation-store'
import type { NativeTranscriptRun } from '../main/bootstrap/run-host'
import type { Evidence } from '../shared/turn-record'
import type { OrchestrationAuthorityHooks } from '../main/remote/orchestration-seam'
import { RemoteInteractionError } from '../main/remote/remote-interaction-broker'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../main/run-registry'
import { recordOrchestrationCommitTiming } from '../main/run-stage-timing'
import { AuthorityEngine } from '../host-runtime/orchestration/authority-engine'
import { createConversationOrdinalResolver } from '../host-runtime/orchestration/conversation-ordinal-lookup'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import type { LegacyLedgerPlan } from '../host-runtime/orchestration/legacy-import'
import { createAuthorityLedgerStore } from './orchestration-authority-ledger'
import { runAuthorityStartupSequence } from './orchestration-authority-startup'
import {
  buildAuthorityStatus,
  createAuthoritySubscribeHub,
  handleAuthorityRunProgress,
  type AppHint,
  type AuthoritySubscribeRuntimeDeps
} from './orchestration-authority-subscribe'
import { AuthorityMcpTrustGate } from './orchestration-trust-gate'
import { createRunTranscriptWrites, observeNativeRunTranscript } from './orchestration-run-transcript'
import { createAuthorityRunTerminalHandler, terminalConversationWriteback } from './orchestration-run-terminal'
import { createQuotaFailureHook } from './usage-limit-capture'
import { takeRestartNoteForRun } from './restart-background-note'
import { createLedgerIdForSubmit } from './orchestration-canonical-run-ids'
import type { UsageLimitScheduler } from './usage-limit-scheduler'
import type { SubscribeHub } from '../host-runtime/orchestration/subscribe-hub'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import type { SubscribeResponse, SubscribeRequest } from '../shared/orchestration-subscribe'
import {
  parseOrchestrationFullfsync,
  parsePendingTtlMs
} from '../host-runtime/orchestration/mode'
import type { RecoverOrchestrationSummary } from '../host-runtime/orchestration/recovery'
import { parseLedgerIntentRouting } from '../host-runtime/orchestration/shadow-routing'
import { createRecorderEvidenceFinder } from '../host-runtime/orchestration/recorder-evidence'
import { ledgerLifecycleFor } from './orchestration-intent-status'
import { TERMINAL_RUN_LIFECYCLES } from '../host-runtime/orchestration/run-transitions'
import { sessionQueueBlocksDispatch } from './orchestration-dispatch-queue'
import { createCanonicalRunIds } from './orchestration-canonical-run-ids'

const DEFAULT_DEFERRED_IMPORT_THRESHOLD = 2_000

export interface DaemonOrchestrationAuthority {
  readonly fullfsync: boolean
  readonly checkpointFullfsync: boolean
  readonly sink: EventSink
  readonly engine: AuthorityEngine
  readonly hooks: OrchestrationAuthorityHooks
  readonly recovery: RecoverOrchestrationSummary
  readonly importComplete: Promise<void>
  readonly subscribeHub: SubscribeHub
  createSubscribeHandler(deps: AuthoritySubscribeRuntimeDeps): (peer: string, request: SubscribeRequest, signal?: AbortSignal) => Promise<SubscribeResponse>
  /** D3: record the lineage of a fork or side chat that already exists natively. */
  recordSessionLineage(input: Parameters<NonNullable<OrchestrationAuthorityHooks['recordSessionLineage']>>[0]): { status: 'recorded' | 'unavailable'; reason?: string }
  recordSessionMetadata(input: Parameters<NonNullable<OrchestrationAuthorityHooks['recordSessionMetadata']>>[0]): { status: 'recorded' | 'unavailable'; reason?: string }
  publishHint(event: AppHint): void
  observeNativeTranscript(homeDir: string, run: NativeTranscriptRun): ReturnType<typeof observeNativeRunTranscript> | undefined
  startImport(): void
  status(): BackgroundServiceOrchestrationStatus
  close(): Promise<void>
}

export interface AttachDaemonOrchestrationAuthorityOptions<
  State extends RunRegistryState = RunRegistryState,
  Control extends RunRegistryControl = RunRegistryControl
> {
  userDataDir: string
  env: NodeJS.ProcessEnv
  conversationStore: () => ConversationStore
  runs: RunRegistry<State, Control>
  requestRunStop: (runId: string) => boolean
  log: (line: string) => void
  beforeCommitHook?: () => void
  deferredImportThreshold?: number
  pauseDeferredImport?: Promise<void>
  attentionSnapshot?: () => SessionAttentionSnapshot
  /** Retention timer; `null` disables it. */ maintenanceIntervalMs?: number | null
  /** C4: quotas and restart notes are recorded only when set. */ usageLimits?: UsageLimitScheduler
}

/**
 * Isolated daemon wiring for P4-2 authoritative orchestration.
 * Runs off-main-thread H1 import + single-tx startup recovery + two-ledger reconciliation
 * before opening the local channel.
 */
export async function attachDaemonOrchestrationAuthority<
  State extends RunRegistryState,
  Control extends RunRegistryControl
>(
  options: AttachDaemonOrchestrationAuthorityOptions<State, Control>
): Promise<DaemonOrchestrationAuthority> {

  // Maintainer decision (2026-11-20): macOS defaults both fullfsync flags ON.
  const fullfsync = parseOrchestrationFullfsync(options.env) ?? true
  const checkpointFullfsync = true
  const pendingTtlMs = parsePendingTtlMs(options.env)
  const deferredThreshold = options.deferredImportThreshold ?? DEFAULT_DEFERRED_IMPORT_THRESHOLD
  const leaseOwner = `daemon:${process.pid}`
  const resolveTurnOrdinal = createConversationOrdinalResolver(options.userDataDir)

  const sink = EventSink.open({
    userDataDir: options.userDataDir,
    fullfsync,
    checkpointFullfsync,
    maxActiveRuns: 1024,
    ...(options.beforeCommitHook ? { beforeCommitHook: options.beforeCommitHook } : {})
  })

  try {
    let deferredStarted = false
    let cancelDeferred: (() => void) | undefined
    const startup = await runAuthorityStartupSequence({
      sink,
      userDataDir: options.userDataDir,
      leaseOwner,
      pendingTtlMs,
      deferredThreshold,
      conversationStore: options.conversationStore,
      resolveTurnOrdinal,
      log: options.log
    })

    return buildAuthorityRuntime({
      options,
      fullfsync,
      checkpointFullfsync,
      pendingTtlMs,
      leaseOwner,
      resolveTurnOrdinal,
      sink,
      recovery: startup.recovery,
      deferredPlan: startup.deferredPlan,
      importComplete: startup.importComplete,
      resolveImportComplete: startup.resolveImportComplete,
      setDeferredControl: (cancel) => { cancelDeferred = cancel },
      getDeferredControl: () => ({ deferredStarted, cancelDeferred, setStarted: () => { deferredStarted = true } })
    })
  } catch (error) {
    try { options.conversationStore().setBeforeTurnSettledObserver(undefined) } catch { /* ignore */ }
    sink.close()
    throw error
  }
}

function buildAuthorityRuntime<
  State extends RunRegistryState,
  Control extends RunRegistryControl
>(ctx: {
  options: AttachDaemonOrchestrationAuthorityOptions<State, Control>
  fullfsync: boolean
  checkpointFullfsync: boolean
  pendingTtlMs: number
  leaseOwner: string
  resolveTurnOrdinal: ReturnType<typeof createConversationOrdinalResolver>
  sink: EventSink
  recovery: RecoverOrchestrationSummary
  deferredPlan: LegacyLedgerPlan | undefined
  importComplete: Promise<void>
  resolveImportComplete: (() => void) | undefined
  setDeferredControl: (cancel: (() => void) | undefined) => void
  getDeferredControl: () => { deferredStarted: boolean; cancelDeferred: (() => void) | undefined; setStarted: () => void }
}): DaemonOrchestrationAuthority {
  const { options, fullfsync, checkpointFullfsync, pendingTtlMs, leaseOwner, resolveTurnOrdinal, sink, recovery } = ctx
  let deferredPlan = ctx.deferredPlan
  const { importComplete, resolveImportComplete } = ctx
  // A3: live-run outcomes read the same committed recorder evidence as startup recovery.
  const findRecorderEvidence = createRecorderEvidenceFinder(options.userDataDir, sink)
  const db = sink.handle.db

  const engine = new AuthorityEngine({
    sink,
    leaseOwner,
    pendingTtlMs,
    resolveTurnOrdinal,
    onCommitTiming: (sample) => {
      recordOrchestrationCommitTiming({ ...sample, fullfsync })
    }
  })

  // Track mapping between the dispatcher run ID and canonical runId when different (conversation turns).
  const ledgerToCanonical = new Map<string, string>()
  const pendingTranscripts = new Map<string, Promise<Evidence<string>>>()
  const transcriptWrites = createRunTranscriptWrites(sink, options.log)
  const trustGate = new AuthorityMcpTrustGate()
  const subscribeHub = createAuthoritySubscribeHub(
    sink,
    options.attentionSnapshot ? () => [{ kind: 'attention', snapshot: options.attentionSnapshot!() }] : undefined
  )
  let progressCounter = 0

  const canonicalIds = createCanonicalRunIds(sink, ledgerToCanonical)
  const { resolveCanonical, resolvePersistedCanonical, trackCanonical } = canonicalIds
    const ledgerIdForSubmit = createLedgerIdForSubmit(db, trackCanonical)

  const readSubmitReceipt = (peer: string, commandId: string) => {
    if (sink.isWriteIndeterminate()) throw new Error('orchestration_write_indeterminate')
    const receipt = sink.getReceipt(commandId, `peer:${peer}`) ?? sink.getReceipt(commandId, 'system')
    return receipt?.type === 'run.submit' && receipt.status === 'accepted' ? receipt : undefined
  }

  const hooks: OrchestrationAuthorityHooks = {
    outbox: () => createOutboxGate(() => db),
    recordSessionLineage: (input) => recordSessionLineage(sink, input, Date.now()),
    takeRestartBackgroundNote: (runId) => takeRestartNoteForRun(db, runId),
    recordSessionMetadata: (input) => recordSessionMetadata(sink, input, Date.now()),
    currentLogId: () => sink.getMeta('log_id'),
    createLedgerStore: () => createAuthorityLedgerStore(sink),

    submitAsync: async (input) => {
      const immediateDispatch = input.immediateDispatch
        ? {
            ...input.immediateDispatch,
            verifyTrustGate: (provider: string, cwd: string | null, runId: string) =>
              trustGate.prepareAndVerify(runId, provider, cwd).ok
          }
        : undefined
      const res = await engine.submitAsync({
        peerCertSHA256: input.peerCertSHA256,
        grantScope: input.grantScope,
        commandId: input.scopedIntentId,
        detail: input.detail,
        ...(input.claimMode ? { claimMode: input.claimMode } : {}),
        ...(immediateDispatch ? { immediateDispatch } : {})
      })
      if (res.kind === 'rejected') throw new Error(res.reason)
      if (!immediateDispatch && res.kind !== 'duplicate') {
        const routing = parseLedgerIntentRouting(res.runId, input.detail)
        trustGate.prepare(res.runId, routing.provider, routing.cwd || sink.getRun(res.runId)?.cwd)
      }
      const ledgerRunId = ledgerIdForSubmit(res.runId, res.kind === 'duplicate')
      return { runId: ledgerRunId, status: res.kind === 'duplicate' ? 'duplicate' : 'recorded', seq: res.seq }
    },

    submitSync: (input) => {
      const immediateDispatch = input.immediateDispatch
        ? {
            ...input.immediateDispatch,
            verifyTrustGate: (provider: string, cwd: string | null, runId: string) =>
              trustGate.prepareAndVerify(runId, provider, cwd).ok
          }
        : undefined
      const res = engine.submitSync({
        peerCertSHA256: input.peerCertSHA256,
        grantScope: input.grantScope,
        commandId: input.scopedIntentId,
        detail: input.detail,
        ...(immediateDispatch ? { immediateDispatch } : {})
      })
      if (res.kind === 'rejected') throw new Error(res.reason)
      if (!immediateDispatch && res.kind !== 'duplicate') {
        const routing = parseLedgerIntentRouting(res.runId, input.detail)
        trustGate.prepare(res.runId, routing.provider, routing.cwd || sink.getRun(res.runId)?.cwd)
      }
      const ledgerRunId = ledgerIdForSubmit(res.runId, res.kind === 'duplicate')
      return { runId: ledgerRunId, status: res.kind === 'duplicate' ? 'duplicate' : 'recorded', seq: res.seq }
    },

    hasSubmitReceipt: (peer, commandId) => readSubmitReceipt(peer, commandId) !== undefined,

    intentStatus: (peer, commandId) => {
      const receipt = readSubmitReceipt(peer, commandId)
      const runId = receipt?.result?.runId
      const run = typeof runId === 'string' ? sink.getRun(runId) : undefined
      if (!run) throw new Error('unknown_intent')
      return { runId: ledgerIdForSubmit(run.runId, true), state: ledgerLifecycleFor(run.lifecycle) }
    },

    compensateSubmitFailure: (runId, reason) => {
      const canonicalRunId = resolveCanonical(runId)
      engine.compensateSubmitFailure(canonicalRunId, reason)
      trustGate.delete(canonicalRunId)
      ledgerToCanonical.delete(runId)
    },

    recoveredRunLifecycle: (runId) => {
      const run = sink.getRun(resolvePersistedCanonical(runId))
      if (!run) return undefined
      // `rolled_back` is terminal for the log but has no H1 lifecycle: the ledger still says cancelled.
      if (run.lifecycle !== 'rolled_back' && TERMINAL_RUN_LIFECYCLES.has(run.lifecycle)) {
        return run.lifecycle as 'settled' | 'failed' | 'cancelled' | 'interrupted'
      }
      return undefined
    },

    resolveIntent: (input) =>
      engine.resolveIntent({
        peerCertSHA256: input.peerCertSHA256,
        grantScope: input.grantScope,
        commandId: input.scopedIntentId
      }),

    beforeDispatch: (input) => {
      const canonicalRunId = resolveCanonical(input.runId)
      // D1: a queued run waits for the session's live run instead of running beside it. The gate
      // defers (no attempt spent) rather than failing, so the queue drains when the head finishes.
      if (sessionQueueBlocksDispatch(sink, canonicalRunId)) {
        return { ok: false as const, action: 'requeue' as const, reason: 'session_run_active', retryAfterMs: 1_000 }
      }
      const routing = parseLedgerIntentRouting(canonicalRunId, input.detail)
      const actor = input.peerCertSHA256 ? `peer:${input.peerCertSHA256}` : 'system'
      let trustGateDetail: string | undefined
      const res = engine.beforeDispatch({
        runId: canonicalRunId,
        cwd: routing.cwd,
        provider: routing.provider,
        profile: routing.profile,
        actor,
        authorizeWorkspace: input.authorizeWorkspace,
        isPeerAuthorized: input.isPeerAuthorized,
        isProviderAuthenticating: input.isProviderAuthenticating,
        verifyTrustGate: () => {
          const targetCwd = routing.cwd || sink.getRun(canonicalRunId)?.cwd
          const targetProvider = routing.provider || sink.getRun(canonicalRunId)?.provider
          const checked = trustGate.verify(canonicalRunId, targetProvider, targetCwd)
          if (!checked.ok) {
            trustGateDetail = checked.detail
            return checked
          }
          return true
        }
      })
      if (!res.ok && res.action === 'fail') {
        trustGate.delete(canonicalRunId)
        ledgerToCanonical.delete(input.runId)
        return trustGateDetail ? { ...res, detail: trustGateDetail } : res
      }
      return res
    },

    onRunProgress: (runId, detail) => {
      if (!detail || sink.isWriteIndeterminate()) return
      handleAuthorityRunProgress(engine, subscribeHub, resolveCanonical(runId), detail, String(++progressCounter))
    },

    onQuestionAnswer: (input) => {
      if (sink.isWriteIndeterminate()) throw new RemoteInteractionError('orchestration_write_indeterminate')
      const res = engine.answerQuestion({
        peerCertSHA256: input.peerCertSHA256,
        grantScope: input.grantScope,
        runId: resolvePersistedCanonical(input.runId),
        questionId: input.questionId,
        answerId: input.answerId,
        answerSha256: input.answerSha256
      })
      if (res.kind === 'rejected') {
        throw new RemoteInteractionError(res.reason)
      }
    },

    onRunStop: (input) =>
      engine.stopRun({
        peerCertSHA256: input.peerCertSHA256,
        grantScope: input.grantScope,
        runId: resolveCanonical(input.runId),
        registry: options.runs,
        stopControl: (control) => {
          options.requestRunStop(control.runId)
        },
        abortLive: input.abortLive
      }),

    onRunTerminal: createAuthorityRunTerminalHandler({
      engine,
      onProviderFailure: createQuotaFailureHook(() => sink, () => options.usageLimits),
      liveRunMeta: (runId) => subscribeHub.liveRunMeta(runId),
      resolveCanonical,
      findRecorderEvidence,
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms)
        timer.unref?.()
      },
      evidenceFor: (step) => [step === 'cancelled' ? 'host.run_completion' : 'provider'],
      // B1/D4: conclude this run's conversation turn now, not at the next restart.
      onTerminalRecorded: terminalConversationWriteback({ sink: () => sink, conversationStore: options.conversationStore }),
      releaseRun: (canonicalRunId, dispatchRunId) => {
        const transcript = pendingTranscripts.get(canonicalRunId)
        pendingTranscripts.delete(canonicalRunId)
        if (transcript) transcriptWrites.enqueue(canonicalRunId, transcript)
        subscribeHub.noteRunTerminal(canonicalRunId)
        trustGate.delete(canonicalRunId)
        ledgerToCanonical.delete(dispatchRunId)
      }
    }),

    isWriteIndeterminate: () => sink.isWriteIndeterminate()
  }

  let closed = false
  const pausedImport = options.pauseDeferredImport
  const startImport = (): void => {
    const plan = deferredPlan
    if (!plan) {
      resolveImportComplete?.()
      return
    }
    const began = runDeferredLegacyImport({
      sink, plan, closed, pendingTtlMs, userDataDir: options.userDataDir, resolveTurnOrdinal,
      control: ctx.getDeferredControl(), log: options.log, resolveImportComplete
    })
    if (began) deferredPlan = undefined
  }

  options.log(`daemon.orchestration-on-ready fullfsync=${fullfsync} checkpointFullfsync=${checkpointFullfsync} recoveredInterrupted=${recovery.interruptedDispatched} closedQuestions=${recovery.closedOpenQuestions}`)

  const maintenance = maybeStartOrchestrationMaintenance({
    sink, log: options.log, maintenanceIntervalMs: options.maintenanceIntervalMs
  })

  return {
    fullfsync, checkpointFullfsync, sink, engine, hooks, recovery, importComplete, subscribeHub,
    recordSessionLineage: (input) => recordSessionLineage(sink, input, Date.now()),
    recordSessionMetadata: (input) => recordSessionMetadata(sink, input, Date.now()),
    ...createTransportHandlers({ sink, subscribeHub, resolveCanonical }),
    observeNativeTranscript: (homeDir, run) =>
      observeAuthorityNativeTranscript({ sink, resolveCanonical, pendingTranscripts, log: options.log }, homeDir, run),
    startImport: pausedImport ? () => { void pausedImport.then(startImport) } : startImport,
    status: () => buildAuthorityStatus(sink),
    close: async () => {
      if (closed) return
      closed = true
      maintenance?.stop()
      subscribeHub.close()
      sink.setCommitObserver(undefined)
      ctx.getDeferredControl().cancelDeferred?.()
      resolveImportComplete?.()
      options.conversationStore().setBeforeTurnSettledObserver(undefined)
      await transcriptWrites.drain()
      sink.close()
    }
  }
}
