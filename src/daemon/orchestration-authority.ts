import { randomUUID } from 'node:crypto'
import type { ConversationStore } from '../main/conversation-store'
import type { OrchestrationAuthorityHooks } from '../main/remote/orchestration-seam'
import { RemoteInteractionError } from '../main/remote/remote-interaction-broker'
import type { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
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
import type { LegacyMirrorWorker } from '../host-runtime/orchestration/legacy-mirror'
import { createAuthorityLedgerStore } from './orchestration-authority-ledger'
import { AuthorityMcpTrustGate } from './orchestration-trust-gate'
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
  mirrorWriteHook?: (op: 'append' | 'compact', seq: number) => void
  mirrorMaxPendingEvents?: number
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
      // Must-Fix 5c: collect pending conversation turn runIds so deferred import never leaves a
      // settled H1 conversation turn unimported before reconcileTwoLedgersOnStartup checks it.
      const pendingConvRunIds = new Set<string>()
      try {
        const ownership = await options.conversationStore().loadOwnership()
        for (const conv of ownership.values()) {
          for (const turn of conv.turns) {
            if (turn.origin === 'dispatch' && turn.delivery.status === 'pending') {
              pendingConvRunIds.add(turn.runId)
            }
          }
        }
      } catch {
        // Corrupt ownership is surfaced by reconcileTwoLedgersOnStartup below.
      }
      importLegacyStateIncrementally({
        sink, userDataDir: options.userDataDir, pendingTtlMs,
        reconcileOpenRuns: true, shadowOnly: false, openOnly: true,
        ...(pendingConvRunIds.size > 0 ? { extraRunIds: pendingConvRunIds } : {}),
        plan, resolveTurnOrdinal
      })
      deferredPlan = plan
      importComplete = new Promise<void>((resolve) => { resolveImportComplete = resolve })
    } else if (plan.unimportedRuns.length > 0 || plan.lastSeq > plan.currentLedgerSeq) {
      importLegacyStateIncrementally({
        sink, userDataDir: options.userDataDir, pendingTtlMs,
        reconcileOpenRuns: true, shadowOnly: false, plan, resolveTurnOrdinal
      })
    }

    // Must-Fix 5b (Decision G): install before-turn-settled observer BEFORE reconcileTwoLedgersOnStartup
    // so reconciled turns also commit `turn.record_delivery` prior to persisting conversations/<id>.json.
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
  let legacyMirror: LegacyMirrorWorker | undefined
  let backingFileStore: SessionLedgerFileStore | undefined
  let progressCounter = 0

  const resolveCanonical = (runId: string): string => ledgerToCanonical.get(runId) ?? runId
  const trackCanonical = (ledgerRunId: string, canonicalRunId: string): void => {
    if (ledgerRunId === canonicalRunId) return
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
          : {})
      })
      backingFileStore = created.fileStore
      legacyMirror = created.mirror
      return { store: created.store, close: created.close }
    },

    submitAsync: async (input) => {
      const res = await engine.submitAsync({
        peerCertSHA256: input.peerCertSHA256,
        grantScope: input.grantScope,
        commandId: input.scopedIntentId,
        detail: input.detail
      })
      if (res.kind === 'rejected') throw new Error(res.reason)
      const routing = parseLedgerIntentRouting(res.runId, input.detail)
      trustGate.prepare(res.runId, routing.provider, routing.cwd || sink.getRun(res.runId)?.cwd)
      const ledgerRunId = UUID_V4_RE.test(res.runId) ? res.runId : randomUUID()
      trackCanonical(ledgerRunId, res.runId)
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
      const routing = parseLedgerIntentRouting(res.runId, input.detail)
      trustGate.prepare(res.runId, routing.provider, routing.cwd || sink.getRun(res.runId)?.cwd)
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
            return false
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
        evidence: ['provider']
      })
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
      .then((s) => options.log(`daemon.orchestration-on-import-done importedRuns=${s.importedRuns} importedSessions=${s.importedSessions}`))
      .catch((e) => options.log(`daemon.orchestration-on-import-failed ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => resolveImportComplete?.())
  }

  options.log(`daemon.orchestration-on-ready fullfsync=${fullfsync} checkpointFullfsync=${checkpointFullfsync} recoveredInterrupted=${recovery.interruptedDispatched} closedQuestions=${recovery.closedOpenQuestions}`)

  return {
    mode, fullfsync, checkpointFullfsync, sink, engine, hooks, recovery, importComplete, startImport,
    flushLegacyMirror: async () => { await legacyMirror?.flush() },
    close: async () => {
      if (closed) return
      closed = true
      ctx.getDeferredControl().cancelDeferred?.()
      resolveImportComplete?.()
      options.conversationStore().setBeforeTurnSettledObserver(undefined)
      await legacyMirror?.close()
      try { backingFileStore?.close() } catch { /* may already be closed */ }
      sink.close()
    }
  }
}
