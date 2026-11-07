import { RemoteGateway } from './remote-gateway'
import type { RemoteCommandSource, RemoteHistoryPreviewSource, RemoteHistorySource, RemoteHistoryTurnsPageSource, RemoteHistoryVersionSource } from './remote-gateway'
import { RemoteDispatcher } from './remote-dispatcher'
import type { RemoteExecutor, RemoteExecutorInput } from './remote-dispatcher'
import { RemoteRunPolicy, GatedExecutor } from './remote-run-policy'
import { readRemoteWorkspace } from './remote-workspace'
import type { RemoteFileDownloads } from './remote-file-download'
import type { RemoteInteractionBroker } from './remote-interaction-broker'
import type { SessionLedger } from './session-ledger'
import type { RunOutputLog } from './run-output-log'
import type { PairingAuthority } from './pairing'
import { ProviderOperationGate } from '../provider-operation-gate'
import { parseRouting } from './host-controller-routing'
import type { HostControllerDependencies, RemoteIntentRouting } from './host-controller-types'

// Wires the device gateway and the exactly-once dispatcher: which reader serves
// each gateway face, and how one submitted intent becomes exactly one Provider
// run. Kept apart from the device API so the controller reads as a list of
// device operations and this file as the composition itself.

function sessionMarkerId(detail: string | undefined): string | undefined {
  if (!detail) return undefined
  try {
    const marker = JSON.parse(detail) as { event?: unknown; externalSessionId?: unknown }
    return marker.event === 'session' && typeof marker.externalSessionId === 'string' && marker.externalSessionId.length <= 256
      ? marker.externalSessionId : undefined
  } catch { return undefined }
}

export interface ExecutionDeps {
  deps: HostControllerDependencies
  authority: PairingAuthority
  ledger: SessionLedger
  output: RunOutputLog
  fileDownloads: RemoteFileDownloads
  interactions: RemoteInteractionBroker
  stops: Map<string, AbortController>
  live: Map<string, { routing: RemoteIntentRouting; externalSessionId?: string }>
  resolveAttachments(routing: RemoteIntentRouting): Promise<RemoteIntentRouting>
  releaseAttachments(routing: RemoteIntentRouting): Promise<void>
  notify(): void
}

export function createExecution(input: ExecutionDeps): { gateway: RemoteGateway; dispatcher: RemoteDispatcher } {
  const { deps, ledger, output, fileDownloads, interactions, stops, live, notify } = input
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

  const policy = new RemoteRunPolicy({ gate: deps.gate ?? new ProviderOperationGate(), workspace: deps.workspace })
  const base: RemoteExecutor = {
    execute: async (executorInput: RemoteExecutorInput) => {
      const stop = new AbortController()
      const routing = await input.resolveAttachments(parseRouting(executorInput.detail))
      const current: { routing: RemoteIntentRouting; externalSessionId?: string } = { routing }
      stops.set(executorInput.runId, stop)
      live.set(executorInput.runId, current)
      try {
        await deps.runProvider({
          runId: executorInput.runId,
          routing,
          progress: (detail) => {
            const sessionId = sessionMarkerId(detail)
            if (sessionId) current.externalSessionId = sessionId
            executorInput.progress(detail)
          },
          output: executorInput.output,
          requestUserInput: (request, signal) => interactions.request(executorInput.runId, request, signal),
          stopSignal: stop.signal,
          // Policy that differs by scope reads the submitting grant's scope, never the
          // transport. A run recovered after a restart has no recorded scope and gets
          // the stricter device semantics.
          grantScope: gateway.runScope(executorInput.runId)
        })
      } finally {
        stops.delete(executorInput.runId)
        live.delete(executorInput.runId)
        interactions.cancelRun(executorInput.runId)
        notify()
      }
    }
  }
  const gated = new GatedExecutor({ policy, resolveTarget: (executorInput) => parseRouting(executorInput.detail), base })
  const dispatcher = new RemoteDispatcher({
    ledger,
    executor: { execute: async (executorInput) => {
      const routing = parseRouting(executorInput.detail)
      try { await gated.execute(executorInput) }
      finally {
        // Attachments are per-intent scratch: released after the run, whatever it did.
        try { await input.releaseAttachments(routing) }
        catch (error) { console.warn('[scry] remote attachment cleanup failed:', error) }
      }
    } },
    outputSink: {
      append: (runId, chunk) => { output.append(runId, chunk); notify() },
      flush: (runId) => output.flush(runId)
    }
  })
  return { gateway, dispatcher }
}
