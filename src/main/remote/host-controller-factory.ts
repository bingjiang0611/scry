import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HostController, type HostControllerDependencies, type RemoteIntentRouting, type RemoteProjectRef, type RemoteDirectoryListing, type RemoteProviderRef, type RemoteCommandCatalog, type RemoteCommandQuery, type RemoteSessionRef, type RemoteHistoryTurn, type RemoteHistoryQuery, type RemoteHistoryPreview } from './host-controller'
import { PairingFileStore } from './pairing-file'
import { SessionLedgerFileStore } from './session-ledger-file'
import { RunOutputWorkerStore } from './run-output-worker'
import type { RunOutputStore } from './run-output-log'
import { recoverDeadRemoteLease } from './recover-dead-lease'
import { ensureHostIdentity } from './host-identity'
import type { VerifiedPairingCSR, IssuedPairingCertificate } from './pairing'
import type { WorkspaceAuthorizer } from './remote-run-policy'
import type { ProviderOperationGate } from '../provider-operation-gate'
import type { AgentQuestionRequest, AgentQuestionResponse } from '../../shared/runtime'

// Production binding for the remote subsystem. It gives HostController the real
// durable persistence (exclusive-lease JSONL ledger + fsynced pairing state) and
// leaves the pieces that require external decisions or the live app as explicit
// injected seams, so this module adds no supply-chain, crypto, or IPC coupling:
//
//   - verifyCSR / issue: the host-side X.509 adapters. Deliberately injected,
//     not implemented here — production must NOT silently gain an X.509
//     dependency or hand-rolled crypto (CLAUDE.md). The proven reference lives
//     in experiments/remote-g0 pending a maintainer dependency decision.
//   - authorizeWorkspace: wraps the app's known-project authority
//     (knownProjectDirectory) so a device can never target an unlisted path.
//   - startRun: delegates to the live run-start path (RunRegistry + Provider
//     adapter). It is the last seam before the IPC handler is touched.
//   - gate: the app-wide ProviderOperationGate, so remote runs share the same
//     auth-vs-run mutual exclusion as local runs.

export interface HostControllerBinding {
  controller: HostController
  // Release the durable leases. Call on app shutdown; a restart re-acquires and
  // the ledger replays any recorded-but-undispatched intents via recover().
  close(): Promise<void>
}

export interface HostControllerFactoryDependencies {
  readDesktop?: HostControllerDependencies['readDesktop']
  desktopDirectories?: HostControllerDependencies['desktopDirectories']
  // Directory under Scry's userData; pairing, ledger and output subdirs are created.
  stateDirectory: string
  // A STABLE host identity across restarts. The persisted pairing state fails
  // closed (host_identity_changed) if this differs from a previous launch, so
  // production must derive it deterministically (e.g. persisted once under
  // userData), never a fresh per-process UUID.
  hostId: string
  anchorSHA256: string
  verifyCSR(csrPEM: string): Promise<VerifiedPairingCSR>
  issue(input: VerifiedPairingCSR & { deviceId: string }): Promise<IssuedPairingCertificate>
  authorizeWorkspace(cwd: string): string
  startRun(input: {
    runId: string
    routing: RemoteIntentRouting
    progress(detail?: string): void
    output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
    requestUserInput(request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionResponse>
    stopSignal: AbortSignal
  }): Promise<void>
  gate: ProviderOperationGate
  // Tests and embedded hosts may inject an equivalent store. Production omits this
  // and always owns the file store inside the dedicated worker.
  createOutputStore?(directory: string): RunOutputStore | Promise<RunOutputStore>
  // Snapshot of host-authorized project directories offered to devices.
  listProjects?(): RemoteProjectRef[]
  listDirectories?(path?: string): RemoteDirectoryListing
  listProviders?(): RemoteProviderRef[]
  listCommands?(query: RemoteCommandQuery): Promise<RemoteCommandCatalog>
  listSessions?(): RemoteSessionRef[]
  sessionCatalogRevision?(): string
  readSessionStatus?: HostControllerDependencies['readSessionStatus']
  macRuns?: HostControllerDependencies['macRuns']
  readHistory?(query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]>
  readHistoryPreview?(query: RemoteHistoryQuery): Promise<RemoteHistoryPreview>
  readHistoryVersion?(query: RemoteHistoryQuery): Promise<import('./remote-gateway').RemoteHistoryVersion>
  readHistoryTurnsPage?(query: import('./remote-gateway').RemoteHistoryTurnsPageQuery): Promise<import('./remote-gateway').RemoteHistoryTurnsPage>
}

// The file stores require a pre-existing private (0700) directory; create it
// exactly, independent of the process umask.
function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

// Higher-level production entry point: derive the persisted host identity (inner
// CA + stable hostId + verifyCSR/issue) from disk, then bind everything. This is
// what index.ts calls; only the live-app seams (workspace authorization,
// startRun, gate) remain to be supplied.
export async function createHostControllerFromDisk(deps: {
  stateDirectory: string
  authorizeWorkspace(cwd: string): string
  startRun(input: {
    runId: string
    routing: RemoteIntentRouting
    progress(detail?: string): void
    output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
    requestUserInput(request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionResponse>
    stopSignal: AbortSignal
  }): Promise<void>
  gate: ProviderOperationGate
}): Promise<HostControllerBinding & { anchorSHA256: string; caCertificatePEM: string }> {
  const identity = await ensureHostIdentity(join(deps.stateDirectory, 'identity'))
  const binding = await createHostController({
    stateDirectory: deps.stateDirectory,
    hostId: identity.hostId,
    anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR,
    issue: identity.issue,
    authorizeWorkspace: deps.authorizeWorkspace,
    startRun: deps.startRun,
    gate: deps.gate
  })
  return Object.assign(binding, { anchorSHA256: identity.anchorSHA256, caCertificatePEM: identity.caCertificatePEM })
}

export async function createHostController(deps: HostControllerFactoryDependencies): Promise<HostControllerBinding> {
  mkdirSync(deps.stateDirectory, { recursive: true })
  const pairingDirectory = privateDir(join(deps.stateDirectory, 'pairing'))
  recoverDeadRemoteLease(pairingDirectory, 'pairing-state.lock')
  const pairingStore = new PairingFileStore(pairingDirectory)
  let ledgerStore: SessionLedgerFileStore
  let outputStore: RunOutputStore
  try {
    const ledgerDirectory = privateDir(join(deps.stateDirectory, 'ledger'))
    recoverDeadRemoteLease(ledgerDirectory, 'session-ledger.lock')
    ledgerStore = new SessionLedgerFileStore(ledgerDirectory)
  } catch (error) {
    // Never leak the pairing lease if the ledger lease cannot be taken.
    pairingStore.close()
    throw error
  }
  try {
    const outputDirectory = privateDir(join(deps.stateDirectory, 'output'))
    recoverDeadRemoteLease(outputDirectory, 'run-output.lock')
    outputStore = await (deps.createOutputStore?.(outputDirectory) ?? RunOutputWorkerStore.create(outputDirectory))
  } catch (error) {
    ledgerStore.close()
    pairingStore.close()
    throw error
  }

  const workspace: WorkspaceAuthorizer = { authorize: (cwd) => deps.authorizeWorkspace(cwd) }
  const controllerDeps: HostControllerDependencies = {
    ...(deps.readDesktop ? { readDesktop: deps.readDesktop } : {}),
    ...(deps.desktopDirectories ? { desktopDirectories: deps.desktopDirectories } : {}),
    pairing: {
      store: pairingStore,
      hostId: deps.hostId,
      anchorSHA256: deps.anchorSHA256,
      verifyCSR: deps.verifyCSR,
      issue: deps.issue
    },
    ledgerStore,
    outputStore,
    workspace,
    gate: deps.gate,
    runProvider: deps.startRun,
    ...(deps.listProjects ? { listProjects: deps.listProjects } : {}),
    ...(deps.listDirectories ? { listDirectories: deps.listDirectories } : {}),
    ...(deps.listProviders ? { listProviders: deps.listProviders } : {}),
    ...(deps.listCommands ? { listCommands: deps.listCommands } : {}),
    ...(deps.listSessions ? { listSessions: deps.listSessions } : {}),
    ...(deps.sessionCatalogRevision ? { sessionCatalogRevision: deps.sessionCatalogRevision } : {}),
    ...(deps.readSessionStatus ? { readSessionStatus: deps.readSessionStatus } : {}),
    ...(deps.macRuns ? { macRuns: deps.macRuns } : {}),
    ...(deps.readHistory ? { readHistory: deps.readHistory } : {}),
    ...(deps.readHistoryPreview ? { readHistoryPreview: deps.readHistoryPreview } : {}),
    ...(deps.readHistoryVersion ? { readHistoryVersion: deps.readHistoryVersion } : {}),
    ...(deps.readHistoryTurnsPage ? { readHistoryTurnsPage: deps.readHistoryTurnsPage } : {})  }

  let controller: HostController
  try {
    controller = new HostController(controllerDeps)
    // Orphaned dispatched runs close as failed (outcome unknown, never re-run);
    // only recorded-but-undispatched intents may start.
    controller.recover()
  } catch (error) {
    try { await outputStore.close() } finally {
      try { ledgerStore.close() } finally { pairingStore.close() }
    }
    throw error
  }

  let closed = false
  return {
    controller,
    close: async () => {
      if (closed) return
      closed = true
      // Release content and lifecycle leases before pairing authority state.
      try { await outputStore.close() } finally {
        try { ledgerStore.close() } finally { pairingStore.close() }
      }
    }
  }
}
