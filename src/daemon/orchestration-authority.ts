import { randomUUID } from 'node:crypto'
import type { ConversationStore } from '../main/conversation-store'
import type { OrchestrationAuthorityHooks } from '../main/remote/orchestration-seam'
import {
  SessionLedgerError,
  type LedgerEvent,
  type LedgerRecovery,
  type LedgerSnapshot,
  type LedgerStore
} from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../main/run-registry'
import { recordOrchestrationCommitTiming } from '../main/run-stage-timing'
import { AuthorityEngine } from '../host-runtime/orchestration/authority-engine'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { createConversationOrdinalResolver } from '../host-runtime/orchestration/conversation-ordinal-lookup'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import {
  importLegacyStateIncrementally,
  loadLegacyLedgerPlanAsync,
  startDeferredLegacyImport,
  type LegacyLedgerPlan
} from '../host-runtime/orchestration/legacy-import'
import { LegacyMirrorWorker } from '../host-runtime/orchestration/legacy-mirror'
import {
  parseOrchestrationFullfsync,
  parseOrchestrationMode,
  parsePendingTtlMs,
  type OrchestrationModeResolution
} from '../host-runtime/orchestration/mode'
import {
  reconcileTwoLedgersOnStartup,
  recoverOrchestrationOnStartup,
  type RecoverOrchestrationSummary
} from '../host-runtime/orchestration/recovery'
import { createRecorderEvidenceFinder } from '../host-runtime/orchestration/recorder-evidence'
import { parseLedgerIntentRouting } from '../host-runtime/orchestration/shadow-routing'

const DEFAULT_DEFERRED_IMPORT_THRESHOLD = 2_000
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
  startImport(): void
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
  deferredImportThreshold?: number
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

  const fullfsync = parseOrchestrationFullfsync(options.env) ?? false
  const checkpointFullfsync = !fullfsync
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
    let deferredPlan: LegacyLedgerPlan | undefined
    let deferredStarted = false
    let cancelDeferred: (() => void) | undefined
    let resolveImportComplete: (() => void) | undefined
    let importComplete: Promise<void> = Promise.resolve()

    const plan = await loadLegacyLedgerPlanAsync(sink, options.userDataDir)
    if (plan.unimportedRuns.length > deferredThreshold) {
      importLegacyStateIncrementally({
        sink,
        userDataDir: options.userDataDir,
        pendingTtlMs,
        reconcileOpenRuns: true,
        shadowOnly: false,
        openOnly: true,
        plan,
        resolveTurnOrdinal
      })
      deferredPlan = plan
      importComplete = new Promise<void>((resolve) => {
        resolveImportComplete = resolve
      })
    } else if (plan.unimportedRuns.length > 0 || plan.lastSeq > plan.currentLedgerSeq) {
      importLegacyStateIncrementally({
        sink,
        userDataDir: options.userDataDir,
        pendingTtlMs,
        reconcileOpenRuns: true,
        shadowOnly: false,
        plan,
        resolveTurnOrdinal
      })
    }

    // core §2.4 + §2.6 + §2.8: recover orchestration.db & two-ledger boundary BEFORE openLocalChannel.
    const recovery = recoverOrchestrationOnStartup({
      sink,
      leaseOwner,
      findRecorderEvidence: createRecorderEvidenceFinder(options.userDataDir, sink)
    })
    await reconcileTwoLedgersOnStartup({ sink, conversationStore: options.conversationStore() })

    return buildAuthorityRuntime({
      options,
      mode,
      fullfsync,
      checkpointFullfsync,
      pendingTtlMs,
      leaseOwner,
      resolveTurnOrdinal,
      sink,
      recovery,
      deferredPlan,
      importComplete,
      resolveImportComplete,
      setDeferredControl: (cancel) => { cancelDeferred = cancel },
      getDeferredControl: () => ({ deferredStarted, cancelDeferred, setStarted: () => { deferredStarted = true } })
    })
  } catch (error) {
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
  let legacyMirror: LegacyMirrorWorker | undefined
  let backingFileStore: SessionLedgerFileStore | undefined
  let progressCounter = 0

  const resolveCanonical = (runId: string): string => ledgerToCanonical.get(runId) ?? runId

  const hooks: OrchestrationAuthorityHooks = {
    createLedgerStore: (ledgerDirectory) => {
      const fileStore = new SessionLedgerFileStore(ledgerDirectory)
      backingFileStore = fileStore
      const initial: LedgerRecovery = fileStore.loadRecovery?.() ?? { events: fileStore.loadAll() }
      let currentSnapshot: LedgerSnapshot | undefined = initial.snapshot
      let memoryEvents: LedgerEvent[] = [...initial.events]
      const mirror = new LegacyMirrorWorker({
        sink,
        ledgerStore: fileStore,
        onError: (error) => {
          const msg = error instanceof Error ? error.message : String(error)
          options.log(`daemon.orchestration-legacy-mirror-error ${msg}`)
        }
      })
      legacyMirror = mirror

      const store: LedgerStore = {
        assertAvailable: () => {
          if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
        },
        loadAll: () => [...(currentSnapshot?.retainedEvents ?? []), ...memoryEvents],
        loadRecovery: () => ({
          ...(currentSnapshot ? { snapshot: structuredClone(currentSnapshot) } : {}),
          events: [...memoryEvents]
        }),
        shouldCompact: (nextEvent) => {
          if ((currentSnapshot?.retainedEvents.length ?? 0) + memoryEvents.length >= 8192) return true
          try {
            return fileStore.shouldCompact(nextEvent)
          } catch {
            return false
          }
        },
        compact: (snapshot) => {
          if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
          // Snapshot MUST be deep-cloned: SessionLedger assigns `this.#events = snapshot.retainedEvents`
          // and pushes subsequent events onto that same array before our async mirror serializes it.
          const frozen = structuredClone(snapshot)
          currentSnapshot = frozen
          memoryEvents = []
          mirror.enqueueCompact(frozen)
        },
        append: (event) => {
          if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
          memoryEvents.push(event)
          // Idle-flushed bounded H1 mirror (plan §9): ZERO sync file fsync pre-first-token.
          mirror.enqueue(event)
        }
      }
      return {
        store,
        close: async () => {
          await mirror.close()
          fileStore.close()
        }
      }
    },

    submitAsync: async (input) => {
      const res = await engine.submitAsync({
        peerCertSHA256: input.peerCertSHA256,
        grantScope: input.grantScope,
        commandId: input.scopedIntentId,
        detail: input.detail
      })
      if (res.kind === 'rejected') throw new Error(res.reason)
      const ledgerRunId = UUID_V4_RE.test(res.runId) ? res.runId : randomUUID()
      if (ledgerRunId !== res.runId) ledgerToCanonical.set(ledgerRunId, res.runId)
      return { runId: ledgerRunId, status: res.kind === 'duplicate' ? 'duplicate' : 'recorded', seq: res.seq }
    },

    submitSync: (input) => {
      const res = engine.submitSync({
        peerCertSHA256: input.peerCertSHA256,
        grantScope: input.grantScope,
        commandId: input.scopedIntentId,
        detail: input.detail
      })
      if (res.kind === 'rejected') throw new Error(res.reason)
      const ledgerRunId = UUID_V4_RE.test(res.runId) ? res.runId : randomUUID()
      if (ledgerRunId !== res.runId) ledgerToCanonical.set(ledgerRunId, res.runId)
      return { runId: ledgerRunId, status: res.kind === 'duplicate' ? 'duplicate' : 'recorded', seq: res.seq }
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
      return engine.beforeDispatch({
        runId: canonicalRunId,
        cwd: routing.cwd,
        provider: routing.provider,
        profile: routing.profile,
        actor,
        authorizeWorkspace: input.authorizeWorkspace,
        isPeerAuthorized: input.isPeerAuthorized,
        isProviderAuthenticating: input.isProviderAuthenticating
      })
    },

    onRunProgress: (runId, detail) => {
      if (!detail || sink.isWriteIndeterminate()) return
      const canonicalRunId = resolveCanonical(runId)
      const suffix = String(++progressCounter)
      if (detail === 'output_capture_failed' || detail === 'history_capture_failed') {
        engine.recordProgress({ runId: canonicalRunId, step: 'content_gap', commandSuffix: suffix, reason: detail })
        return
      }
      try {
        const marker = JSON.parse(detail) as Record<string, unknown>
        if (marker.event === 'session' && typeof marker.externalSessionId === 'string') {
          engine.recordProgress({
            runId: canonicalRunId,
            step: 'session_bound',
            commandSuffix: suffix,
            nativeSessionId: marker.externalSessionId
          })
        } else if (marker.event === 'question_opened' && typeof marker.questionId === 'string') {
          engine.recordProgress({
            runId: canonicalRunId,
            step: 'question_opened',
            commandSuffix: `${marker.questionId}-${suffix}`,
            questionId: marker.questionId,
            questionKind: typeof marker.kind === 'string' ? marker.kind : 'question'
          })
        } else if (marker.event === 'question_closed' && typeof marker.questionId === 'string') {
          engine.recordProgress({
            runId: canonicalRunId,
            step: 'question_closed',
            commandSuffix: `${marker.questionId}-${suffix}`,
            questionId: marker.questionId,
            ...(typeof marker.reason === 'string' ? { reason: marker.reason } : {})
          })
        }
      } catch {
        // Opaque non-JSON progress marker; no orchestration state change needed.
      }
    },

    onQuestionAnswer: (input) => {
      if (sink.isWriteIndeterminate()) throw new Error('orchestration_write_indeterminate')
      engine.answerQuestion({
        peerCertSHA256: input.peerCertSHA256,
        grantScope: input.grantScope,
        runId: resolveCanonical(input.runId),
        questionId: input.questionId,
        answerId: input.answerId,
        answerSha256: input.answerSha256
      })
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
        evidence: ['provider']
      })
      ledgerToCanonical.delete(runId)
    },

    isWriteIndeterminate: () => sink.isWriteIndeterminate()
  }

  // Decision G: in authoritative `on` mode, commit `turn.record_delivery` to orchestration.db
  // BEFORE `ConversationStore.persist` writes `conversations/<id>.json`.
  options.conversationStore().setBeforeTurnSettledObserver((info) => {
    if (sink.isWriteIndeterminate()) return
    const at = Date.now()
    const delivery = info.delivery.status
    const payload = {
      sessionKey: info.conversationId,
      runId: info.runId,
      ordinal: info.ordinal,
      delivery,
      ...(info.delivery.status !== 'accepted' ? { reason: info.delivery.reason } : {}),
      settledAt: at,
      evidence: [`conversation:${info.conversationId}`]
    }
    sink.execute({
      type: 'turn.record_delivery',
      commandId: `effect:p4-conv-${info.conversationId}-${info.runId}:${delivery}`,
      actor: `effect:p4-conv-${info.conversationId}`,
      scope: 'system',
      at,
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
  })

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
      sink,
      userDataDir: options.userDataDir,
      pendingTtlMs,
      reconcileOpenRuns: true,
      shadowOnly: false,
      plan: targetPlan,
      resolveTurnOrdinal
    })
    ctx.setDeferredControl(handle.cancel)
    handle.promise
      .then((summary) => {
        options.log(
          `daemon.orchestration-on-import-done importedRuns=${summary.importedRuns} importedSessions=${summary.importedSessions}`
        )
      })
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error)
        options.log(`daemon.orchestration-on-import-failed ${msg}`)
      })
      .finally(() => resolveImportComplete?.())
  }

  options.log(
    `daemon.orchestration-on-ready fullfsync=${String(fullfsync)} checkpointFullfsync=${String(checkpointFullfsync)} recoveredInterrupted=${recovery.interruptedDispatched} closedQuestions=${recovery.closedOpenQuestions}`
  )

  return {
    mode,
    fullfsync,
    checkpointFullfsync,
    sink,
    engine,
    hooks,
    recovery,
    importComplete,
    startImport,
    flushLegacyMirror: async () => {
      await legacyMirror?.flush()
    },
    close: async () => {
      if (closed) return
      closed = true
      ctx.getDeferredControl().cancelDeferred?.()
      resolveImportComplete?.()
      options.conversationStore().setBeforeTurnSettledObserver(undefined)
      await legacyMirror?.close()
      try {
        backingFileStore?.close()
      } catch {
        // Backing store may already be closed by HostController.
      }
      sink.close()
    }
  }
}
