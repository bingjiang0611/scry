import { randomUUID } from 'node:crypto'
import type { BackgroundServiceOrchestrationStatus } from '../shared/background-service'
import type { ConversationStore } from '../main/conversation-store'
import type { OrchestrationAuthorityHooks } from '../main/remote/orchestration-seam'
import { RemoteInteractionError } from '../main/remote/remote-interaction-broker'
import type { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../main/run-registry'
import { recordOrchestrationCommitTiming } from '../main/run-stage-timing'
import { AuthorityEngine } from '../host-runtime/orchestration/authority-engine'
import { createConversationOrdinalResolver } from '../host-runtime/orchestration/conversation-ordinal-lookup'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { startDeferredLegacyImport, type LegacyLedgerPlan } from '../host-runtime/orchestration/legacy-import'
import type { LegacyMirrorWorker } from '../host-runtime/orchestration/legacy-mirror'
import { createAuthorityLedgerStore } from './orchestration-authority-ledger'
import { runAuthorityStartupSequence } from './orchestration-authority-startup'
import {
  buildAuthorityStatus,
  createAuthoritySubscribeHandler,
  createAuthoritySubscribeHub,
  forwardAppEventToSubscribeHub,
  handleAuthorityRunProgress,
  type AuthoritySubscribeRuntimeDeps
} from './orchestration-authority-subscribe'
import { AuthorityMcpTrustGate } from './orchestration-trust-gate'
import type { SubscribeHub } from '../host-runtime/orchestration/subscribe-hub'
import type { AppEvent } from '../main/remote/app-event-feed'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import type { SubscribeReply, SubscribeRequest } from '../shared/orchestration-subscribe'
import {
  parseOrchestrationFullfsync,
  parseOrchestrationMode,
  parsePendingTtlMs,
  type OrchestrationModeResolution
} from '../host-runtime/orchestration/mode'
import type { RecoverOrchestrationSummary } from '../host-runtime/orchestration/recovery'
import { parseLedgerIntentRouting } from '../host-runtime/orchestration/shadow-routing'

const DEFAULT_DEFERRED_IMPORT_THRESHOLD = 2_000
const MAX_LEDGER_CANONICAL_MAP = 4_096
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface DaemonOrchestrationAuthority {
  readonly mode: OrchestrationModeResolution
  readonly fullfsync: boolean
  readonly checkpointFullfsync: boolean
  readonly sink: EventSink
  readonly engine: AuthorityEngine
  readonly hooks: OrchestrationAuthorityHooks
  readonly recovery: RecoverOrchestrationSummary
  readonly importComplete: Promise<void>
  readonly subscribeHub: SubscribeHub
  createSubscribeHandler(deps: AuthoritySubscribeRuntimeDeps): (peer: string, request: SubscribeRequest, signal?: AbortSignal) => Promise<SubscribeReply>
  forwardAppEvent(event: AppEvent): void
  startImport(): void
  status(): BackgroundServiceOrchestrationStatus
  flushLegacyMirror(): Promise<void>
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
  mirrorWriteHook?: (op: 'append' | 'compact', seq: number) => void
  mirrorMaxPendingEvents?: number
  mirrorRetryIntervalMs?: number
  deferredImportThreshold?: number
  attentionSnapshot?: () => SessionAttentionSnapshot
}

/**
 * Isolated daemon wiring for P4-2 authoritative orchestration (`SCRY_ORCHESTRATION=on`).
 * Runs off-main-thread H1 import + single-tx startup recovery + two-ledger reconciliation
 * BEFORE `openLocalChannel`, and mirrors committed events asynchronously to H1 off critical path.
 */
export async function attachDaemonOrchestrationAuthority<
  State extends RunRegistryState,
  Control extends RunRegistryControl
>(
  options: AttachDaemonOrchestrationAuthorityOptions<State, Control>
): Promise<DaemonOrchestrationAuthority | undefined> {
  const mode = parseOrchestrationMode(options.env)
  if (mode.effective !== 'on') return undefined

  // Maintainer decision (2026-11-20): macOS defaults fullfsync=ON and checkpoint_fullfsync=ON.
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
      mode,
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
      h1DiskLastSeq: startup.h1DiskLastSeq,
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
  mode: OrchestrationModeResolution
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
  h1DiskLastSeq: number
  setDeferredControl: (cancel: (() => void) | undefined) => void
  getDeferredControl: () => { deferredStarted: boolean; cancelDeferred: (() => void) | undefined; setStarted: () => void }
}): DaemonOrchestrationAuthority {
  const { options, mode, fullfsync, checkpointFullfsync, pendingTtlMs, leaseOwner, resolveTurnOrdinal, sink, recovery } = ctx
  let deferredPlan = ctx.deferredPlan
  const { importComplete, resolveImportComplete } = ctx

  const engine = new AuthorityEngine({
    sink,
    leaseOwner,
    pendingTtlMs,
    resolveTurnOrdinal,
    onCommitTiming: (sample) => {
      recordOrchestrationCommitTiming({ ...sample, fullfsync })
    }
  })

  // Track mapping between H1 in-memory ledgerRunId and canonical runId when different (conversation turns).
  const ledgerToCanonical = new Map<string, string>()
  const trustGate = new AuthorityMcpTrustGate()
  const subscribeHub = createAuthoritySubscribeHub(
    sink,
    options.attentionSnapshot ? () => [{ kind: 'attention', snapshot: options.attentionSnapshot!() }] : undefined
  )
  let legacyMirror: LegacyMirrorWorker | undefined
  let backingFileStore: SessionLedgerFileStore | undefined
  let syncMirrorSnapshot: (() => void) | undefined
  let readH1FallbackStatus: (() => { unavailable: boolean; reason?: string }) | undefined
  let progressCounter = 0

  const resolveCanonical = (runId: string): string => ledgerToCanonical.get(runId) ?? runId
  const trackCanonical = (ledgerRunId: string, canonicalRunId: string): void => {
    if (ledgerRunId === canonicalRunId) return
    if (!sink.isWriteIndeterminate() && sink.handle.db.open) {
      try {
        sink.handle.db
          .prepare('INSERT OR IGNORE INTO orch_legacy_run (ledger_run_id, run_id) VALUES (?, ?)')
          .run(ledgerRunId, canonicalRunId)
      } catch {
        // Ignore if mapping already present or sink fenced.
      }
    }
    ledgerToCanonical.delete(ledgerRunId)
    ledgerToCanonical.set(ledgerRunId, canonicalRunId)
    while (ledgerToCanonical.size > MAX_LEDGER_CANONICAL_MAP) {
      const oldest = ledgerToCanonical.keys().next().value
      if (oldest === undefined) break
      ledgerToCanonical.delete(oldest)
    }
  }

  const hooks: OrchestrationAuthorityHooks = {
    createLedgerStore: (ledgerDirectory) => {
      const created = createAuthorityLedgerStore({
        ledgerDirectory,
        sink,
        log: options.log,
        ...(options.mirrorWriteHook ? { mirrorWriteHook: options.mirrorWriteHook } : {}),
        ...(options.mirrorMaxPendingEvents !== undefined
          ? { mirrorMaxPendingEvents: options.mirrorMaxPendingEvents }
          : {}),
        ...(options.mirrorRetryIntervalMs !== undefined
          ? { mirrorRetryIntervalMs: options.mirrorRetryIntervalMs }
          : {}),
        h1DiskLastSeq: ctx.h1DiskLastSeq
      })
      backingFileStore = created.fileStore
      legacyMirror = created.mirror
      syncMirrorSnapshot = created.syncSnapshotFromDb
      readH1FallbackStatus = created.h1FallbackStatus
      return { store: created.store, close: created.close }
    },

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
        ...(immediateDispatch ? { immediateDispatch } : {})
      })
      if (res.kind === 'rejected') throw new Error(res.reason)
      if (!immediateDispatch) {
        const routing = parseLedgerIntentRouting(res.runId, input.detail)
        trustGate.prepare(res.runId, routing.provider, routing.cwd || sink.getRun(res.runId)?.cwd)
      }
      const ledgerRunId = UUID_V4_RE.test(res.runId) ? res.runId : randomUUID()
      trackCanonical(ledgerRunId, res.runId)
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
      if (!immediateDispatch) {
        const routing = parseLedgerIntentRouting(res.runId, input.detail)
        trustGate.prepare(res.runId, routing.provider, routing.cwd || sink.getRun(res.runId)?.cwd)
      }
      const ledgerRunId = UUID_V4_RE.test(res.runId) ? res.runId : randomUUID()
      trackCanonical(ledgerRunId, res.runId)
      return { runId: ledgerRunId, status: res.kind === 'duplicate' ? 'duplicate' : 'recorded', seq: res.seq }
    },

    compensateSubmitFailure: (runId, reason) => {
      const canonicalRunId = resolveCanonical(runId)
      engine.compensateSubmitFailure(canonicalRunId, reason)
      trustGate.delete(canonicalRunId)
      ledgerToCanonical.delete(runId)
    },

    recoveredRunLifecycle: (runId) => {
      const run = sink.getRun(resolveCanonical(runId))
      if (!run) return undefined
      if (run.lifecycle === 'settled' || run.lifecycle === 'failed' || run.lifecycle === 'cancelled' || run.lifecycle === 'interrupted') {
        return run.lifecycle
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
        runId: resolveCanonical(input.runId),
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

    onRunTerminal: (runId, step, detail) => {
      const canonicalRunId = resolveCanonical(runId)
      engine.recordTerminal({
        runId: canonicalRunId,
        step,
        ...(detail ? { reason: detail } : {}),
        evidence: [step === 'cancelled' ? 'host.run_completion' : 'provider']
      })
      subscribeHub.noteRunTerminal(canonicalRunId)
      trustGate.delete(canonicalRunId)
      ledgerToCanonical.delete(runId)
    },

    isWriteIndeterminate: () => sink.isWriteIndeterminate()
  }

  let closed = false
  const startImport = (): void => {
    const ctrl = ctx.getDeferredControl()
    if (!deferredPlan || ctrl.deferredStarted || closed || sink.isWriteIndeterminate()) {
      resolveImportComplete?.()
      return
    }
    ctrl.setStarted()
    const targetPlan = deferredPlan
    deferredPlan = undefined
    const handle = startDeferredLegacyImport({
      sink, userDataDir: options.userDataDir, pendingTtlMs,
      reconcileOpenRuns: true, shadowOnly: false, plan: targetPlan, resolveTurnOrdinal
    })
    ctx.setDeferredControl(handle.cancel)
    handle.promise
      .then((s) => {
        if (!closed) syncMirrorSnapshot?.()
        options.log(`daemon.orchestration-on-import-done importedRuns=${s.importedRuns} importedSessions=${s.importedSessions}`)
      })
      .catch((e) => options.log(`daemon.orchestration-on-import-failed ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => resolveImportComplete?.())
  }

  options.log(`daemon.orchestration-on-ready fullfsync=${fullfsync} checkpointFullfsync=${checkpointFullfsync} recoveredInterrupted=${recovery.interruptedDispatched} closedQuestions=${recovery.closedOpenQuestions}`)

  const status = (): BackgroundServiceOrchestrationStatus => buildAuthorityStatus(sink, readH1FallbackStatus)

  return {
    mode, fullfsync, checkpointFullfsync, sink, engine, hooks, recovery, importComplete, subscribeHub,
    createSubscribeHandler: (deps) => createAuthoritySubscribeHandler(sink, subscribeHub, deps),
    forwardAppEvent: (event) => forwardAppEventToSubscribeHub(subscribeHub, event, resolveCanonical),
    startImport, status,
    flushLegacyMirror: async () => { await legacyMirror?.flush() },
    close: async () => {
      if (closed) return
      closed = true
      subscribeHub.close()
      sink.setCommitObserver(undefined)
      ctx.getDeferredControl().cancelDeferred?.()
      resolveImportComplete?.()
      options.conversationStore().setBeforeTurnSettledObserver(undefined)
      await legacyMirror?.close()
      try { backingFileStore?.close() } catch { /* may already be closed */ }
      sink.close()
    }
  }
}
