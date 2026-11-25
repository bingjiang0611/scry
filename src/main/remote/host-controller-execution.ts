import { randomUUID } from 'node:crypto'
import { prependRestartNoteToDetail } from '../../daemon/restart-background-note'
import { RemoteGateway } from './remote-gateway'
import type { RemoteCommandSource, RemoteHistoryPreviewSource, RemoteHistorySource, RemoteHistoryTurnsPageSource, RemoteHistoryVersionSource } from './remote-gateway'
import { RemoteDispatcher } from './remote-dispatcher'
import type { RemoteExecutor, RemoteExecutorInput } from './remote-dispatcher'
import { RemoteRunPolicy, GatedExecutor } from './remote-run-policy'
import { readRemoteWorkspace } from './remote-workspace'
import type { RemoteFileDownloads } from './remote-file-download'
import type { RemoteInteractionBroker, RemoteQuestionAnswer } from './remote-interaction-broker'
import type { LedgerEvent, SessionLedger } from './session-ledger'
import type { RunOutputLog } from './run-output-log'
import type { PairingAuthority } from './pairing'
import { ProviderOperationGate, providerOperationKey } from '../provider-operation-gate'
import { parseRouting, HOST_RESTARTED_DETAIL } from './host-controller-routing'
import type { HostControllerDependencies, RemoteIntentRouting } from './host-controller-types'
import type { OrchestrationAuthorityHooks, OrchestrationImmediateDispatchChecks } from './orchestration-seam'

/** Startup reconciliation for orphaned dispatched runs (core §2.4: interrupted != failed). */
export function recoverDispatchedLedgerRuns(
  ledger: SessionLedger,
  orchestration?: OrchestrationAuthorityHooks
): void {
  for (const runId of ledger.dispatchedRuns()) {
    if (orchestration?.recoveredRunLifecycle) {
      const recovered = orchestration.recoveredRunLifecycle(runId)
      if (recovered === 'settled') {
        ledger.markSettled(runId)
        continue
      }
      if (recovered === 'failed') {
        ledger.markFailed(runId, HOST_RESTARTED_DETAIL)
        continue
      }
      ledger.markProgress(runId, JSON.stringify({ event: 'interrupted', reason: 'host_restarted' }))
      ledger.markCancelled(runId)
      continue
    }
    ledger.markFailed(runId, HOST_RESTARTED_DETAIL)
  }
}

// Wires the device gateway and the exactly-once dispatcher: which reader serves
// each gateway face, and how one submitted intent becomes exactly one Provider
// run. Kept apart from the device API so the controller reads as a list of
// device operations and this file as the composition itself.

export interface ExecutionDeps {
  deps: HostControllerDependencies
  authority: PairingAuthority
  ledger: SessionLedger
  output: RunOutputLog
  fileDownloads: RemoteFileDownloads
  interactions: RemoteInteractionBroker
  stops: Map<string, AbortController>
  resolveAttachments(routing: RemoteIntentRouting): Promise<RemoteIntentRouting>
  releaseAttachments(routing: RemoteIntentRouting): Promise<void>
}

/** Tell the App subscription which run changed; observation only, never fails the run. */
export function runActivity(deps: Pick<HostControllerDependencies, 'onRunActivity'>, runId: string, ledger: Pick<SessionLedger, 'intentSeq'>): void {
  try { deps.onRunActivity?.(runId, ledger.intentSeq(runId)) } catch (error) { console.warn('[scry] run activity notice failed:', error) }
}

const controllerMetaByDeps = new WeakMap<object, { gateway: RemoteGateway; interactions: RemoteInteractionBroker }>()

function resolveAnsweredByPeer(
  interactions: RemoteInteractionBroker,
  event: LedgerEvent
): string | undefined {
  if (event.kind !== 'run_progress' || !event.detail?.includes('"question_answered"')) return undefined
  try {
    const marker = JSON.parse(event.detail) as { event?: unknown; questionId?: unknown; answerId?: unknown }
    if (marker.event !== 'question_answered') return undefined
    if (typeof marker.questionId !== 'string' || typeof marker.answerId !== 'string') return undefined
    return interactions.answeredByPeer(event.runId, marker.questionId, marker.answerId)
  } catch {
    return undefined
  }
}

/** Projects progress and names the changed run for the App subscription. */
export function ledgerEventObserver(
  deps: Pick<HostControllerDependencies, 'onRunActivity' | 'onLedgerEvent' | 'orchestration'>
): (event: LedgerEvent, intentSeq?: number) => void {
  return (event, intentSeq) => {
    runActivity(deps, event.runId, { intentSeq: () => intentSeq })
    if (deps.orchestration && event.kind === 'run_progress') {
      try { deps.orchestration.onRunProgress(event.runId, event.detail) } catch { /* ignore */ }
    }
    try {
      const entry = controllerMetaByDeps.get(deps)
      const runMeta = entry?.gateway.runMeta(event.runId)
      const answeredByPeer = entry ? resolveAnsweredByPeer(entry.interactions, event) : undefined
      const meta =
        runMeta || answeredByPeer
          ? { ...(runMeta ?? {}), ...(answeredByPeer ? { answeredByPeer } : {}) }
          : undefined
      deps.onLedgerEvent?.(event, meta)
    } catch { /* shadow observation must never fail a run */ }
  }
}

export function createExecution(input: ExecutionDeps): {
  gateway: RemoteGateway
  dispatcher: RemoteDispatcher
  immediateDispatch: OrchestrationImmediateDispatchChecks
  dispose(): void
} {
  const { deps, ledger, output, fileDownloads, interactions, stops } = input
  const gateway = new RemoteGateway({
    authority: input.authority,
    ledger,
    output,
    ...(deps.listProjects ? { projects: { list: deps.listProjects } } : {}),
    ...(deps.listDirectories ? { directories: { list: deps.listDirectories } } : {}),
    ...(deps.listProviders || deps.listProvidersFull || deps.listProviderControls ? {
      providers: {
        ...(deps.listProviders ? { list: deps.listProviders } : {}),
        ...(deps.listProvidersFull ? { listFull: deps.listProvidersFull } : {}),
        ...(deps.listProviderControls ? { selected: deps.listProviderControls } : {})
      }
    } : {}),
    ...(deps.listCommands ? { commands: { list: deps.listCommands } as RemoteCommandSource } : {}),
    workspace: { read: (query) => readRemoteWorkspace(deps.workspace, query, deps.readSessionStatus) },
    fileDownloads,
    ...(deps.listSessions ? { sessions: { list: deps.listSessions, ...(deps.sessionCatalogRevision ? { revision: deps.sessionCatalogRevision } : {}) } } : {}),
    ...(deps.readHistory ? { history: { read: deps.readHistory } as RemoteHistorySource } : {}),
    ...(deps.readHistoryPreview ? { historyPreview: { read: deps.readHistoryPreview } as RemoteHistoryPreviewSource } : {}),
    ...(deps.readHistoryVersion ? { historyVersion: { read: deps.readHistoryVersion } as RemoteHistoryVersionSource } : {}),
    ...(deps.readHistoryTurnsPage ? { historyTurnsPage: { read: deps.readHistoryTurnsPage } as RemoteHistoryTurnsPageSource } : {})
  })
  controllerMetaByDeps.set(deps, { gateway, interactions })

  // Runs that got as far as the run start; any other failure was a refusal by the ledger.
  const reached = new Set<string>()
  const gate = deps.gate ?? new ProviderOperationGate()
  const policy = new RemoteRunPolicy({ gate, workspace: deps.workspace })
  const base: RemoteExecutor = {
    execute: async (executorInput: RemoteExecutorInput) => {
      const stop = new AbortController()
      const scope = gateway.runScope(executorInput.runId)
      const routing = await input.resolveAttachments(parseRouting(executorInput.detail, scope))
      stops.set(executorInput.runId, stop)
      reached.add(executorInput.runId)
      try {
        return await deps.runProvider({
          runId: executorInput.runId,
          routing,
          progress: executorInput.progress,
          output: executorInput.output,
          // Content-free trace changes name the run for the App subscription (P3f E2).
          activity: () => runActivity(deps, executorInput.runId, ledger),
          requestUserInput: (request, signal) => interactions.request(executorInput.runId, request, signal),
          stopSignal: stop.signal,
          // Policy that differs by scope reads the submitting grant's scope, never the
          // transport. A run recovered after a restart has no recorded scope and gets
          // the stricter device semantics.
          grantScope: scope
        })
      } finally {
        stops.delete(executorInput.runId)
        interactions.cancelRun(executorInput.runId)
      }
    }
  }
  const gated = new GatedExecutor({
    policy,
    resolveTarget: (executorInput): RemoteIntentRouting & { grantScope: 'local' | 'remote' } => {
      const grantScope = gateway.runScope(executorInput.runId)
      return { ...parseRouting(executorInput.detail, grantScope), grantScope }
    },
    base
  })
  const immediateDispatch: OrchestrationImmediateDispatchChecks = {
    isPeerAuthorized: (peer) => input.authority.authorizesCertificate(peer),
    authorizeWorkspace: (cwd) => deps.workspace.authorize(cwd),
    isProviderAuthenticating: (provider, profile) => {
      const lease = gate.acquireOperation(providerOperationKey(provider, profile ?? undefined))
      if (lease.ok) {
        lease.release()
        return false
      }
      return true
    }
  }
  const dispatcher = new RemoteDispatcher({
    ledger,
    ...(deps.orchestration ? {
      // B1: dispatch claims come from the durable outbox; the ledger still owns intent detail.
      outbox: deps.orchestration.outbox(),
      beforeDispatch: (runId, detail) => {
        const meta = gateway.runMeta(runId)
        const check = deps.orchestration!.beforeDispatch({
          runId,
          detail,
          peerCertSHA256: meta?.peerCertSHA256,
          grantScope: meta?.grantScope ?? gateway.runScope(runId),
          ...immediateDispatch
        })
        if (!check.ok && check.action === 'fail') {
          try { deps.onDispatchRefused?.({ detail, grantScope: gateway.runScope(runId), error: new Error(check.detail ?? check.reason) }) }
          catch { /* ignore refusal hook error */ }
        }
        return check
      },
      // C4: the one turn that continues a session after a restart is told what the previous process
      // cancelled. Reading the note removes it, so later turns do not repeat it.
      rewriteDetail: (runId, detail) => prependRestartNoteToDetail(detail, deps.orchestration?.takeRestartBackgroundNote?.(runId)),
      onSettled: (runId, lifecycle, detail) => {
        deps.orchestration!.onRunTerminal(runId, lifecycle, detail)
      },
      // B1/A4: stop and answer effects must reach completion from the durable queue, not only
      // from the in-memory request path, so a restart cannot lose them.
      effectExecutor: (effect) => {
        if (effect.kind === 'provider.run.stop') {
          const controller = effect.runId ? stops.get(effect.runId) : undefined
          controller?.abort()
          // A stop for a run that is no longer live already has its outcome; nothing to wait for.
          return 'done'
        }
        if (effect.kind === 'question.respond') {
          if (!effect.runId) return 'failed'
          try {
            const response = JSON.parse(effect.payload).response as RemoteQuestionAnswer['response']
            interactions.answer(effect.runId, { answerId: randomUUID(), response })
            return 'done'
          } catch {
            // A question the Provider already closed is not a retryable failure.
            return 'failed'
          }
        }
        return 'failed'
      }
    } : {}),
    executor: { execute: async (executorInput) => {
      try {
        const routing = parseRouting(executorInput.detail, gateway.runScope(executorInput.runId))
        try { return await gated.execute(executorInput) }
        finally {
          // Attachments are per-intent scratch: released after the run, whatever it did.
          try { await input.releaseAttachments(routing) }
          catch (error) { console.warn('[scry] remote attachment cleanup failed:', error) }
        }
      } catch (error) {
        if (!reached.has(executorInput.runId)) {
          try { deps.onDispatchRefused?.({ detail: executorInput.detail, grantScope: gateway.runScope(executorInput.runId), error }) }
          catch (hookError) { console.warn('[scry] dispatch refusal hook failed:', hookError) }
        }
        throw error
      } finally {
        reached.delete(executorInput.runId)
      }
    } },
    outputSink: {
      append: (runId, chunk) => { output.append(runId, chunk); runActivity(deps, runId, ledger) },
      flush: (runId) => output.flush(runId)
    }
  })
  const unsubscribeGate = deps.orchestration
    ? gate.onAuthenticationReleased(() => {
        // The rows deferred because this auth lease was held are exactly the ones to reconsider.
        dispatcher.wake()
        dispatcher.pump()
      })
    : () => undefined
  return {
    gateway,
    dispatcher,
    immediateDispatch,
    dispose: () => {
      unsubscribeGate()
      dispatcher.dispose()
    }
  }
}
