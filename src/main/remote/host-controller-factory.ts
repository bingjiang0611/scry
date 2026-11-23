import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HostController, type HostControllerDependencies, type RemoteProjectRef, type RemoteDirectoryListing, type RemoteProviderRef, type RemoteCommandCatalog, type RemoteCommandQuery, type RemoteSessionRef, type RemoteHistoryTurn, type RemoteHistoryQuery, type RemoteHistoryPreview } from './host-controller'
import { PairingFileStore } from './pairing-file'
import { RunOutputWorkerStore } from './run-output-worker'
import type { RunOutputStore } from './run-output-log'
import { recoverDeadRemoteLease } from './recover-dead-lease'
import type { VerifiedPairingCSR, IssuedPairingCertificate } from './pairing'
import type { WorkspaceAuthorizer } from './remote-run-policy'
import type { ProviderOperationGate } from '../provider-operation-gate'
import type { DesktopAttachmentStore } from './desktop-attachments'
import { createProviderPrewarmer } from './remote-provider-prewarm'
import type { LedgerStore } from './session-ledger'
import type { OrchestrationAuthorityHooks } from './orchestration-seam'

// The daemon injects SQLite authority. Pairing and run output have separate
// durable stores and leases; standalone protocol fixtures use a transient dispatcher.
const transientLedgerStore: LedgerStore = {
  assertAvailable: () => undefined,
  loadAll: () => [],
  append: () => undefined,
  compact: () => undefined
}

export interface HostControllerBinding {
  controller: HostController
  // Release pairing and output leases on shutdown.
  close(): Promise<void>
}

export interface HostControllerFactoryDependencies {
  readDesktop?: HostControllerDependencies['readDesktop']
  desktopWorkbench?: import('./desktop-workbench').DesktopWorkbenchHost
  desktopDirectories?: HostControllerDependencies['desktopDirectories']
  // Directory under Scry's userData; pairing and output subdirs are created.
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
  startRun: HostControllerDependencies['runProvider']
  onDispatchRefused?: HostControllerDependencies['onDispatchRefused']
  onRunActivity?: HostControllerDependencies['onRunActivity']
  onLedgerEvent?: HostControllerDependencies['onLedgerEvent']
  orchestration?: OrchestrationAuthorityHooks
  gate: ProviderOperationGate
  // Tests and embedded hosts may inject an equivalent store. Production omits this
  // and always owns the file store inside the dedicated worker.
  createOutputStore?(directory: string): RunOutputStore | Promise<RunOutputStore>
  attachmentStore?: DesktopAttachmentStore
  attachmentDirectory?: string
  // Snapshot of host-authorized project directories offered to devices.
  listProjects?(): RemoteProjectRef[]
  listDirectories?(path?: string): RemoteDirectoryListing
  listProviders?(): RemoteProviderRef[]
  listProvidersFull?: HostControllerDependencies['listProvidersFull']
  listProviderControls?: HostControllerDependencies['listProviderControls']
  listCommands?(query: RemoteCommandQuery): Promise<RemoteCommandCatalog>
  sessionAction?: HostControllerDependencies['sessionAction']
  sessionFork?: HostControllerDependencies['sessionFork']
  sessionDelete?: HostControllerDependencies['sessionDelete']
  toolPanels?: HostControllerDependencies['toolPanels']
  listSessions?(): RemoteSessionRef[]
  sessionCatalogRevision?(): string
  readSessionStatus?: HostControllerDependencies['readSessionStatus']
  macRuns?: HostControllerDependencies['macRuns']
  readHistory?(query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]>
  readHistoryPreview?(query: RemoteHistoryQuery): Promise<RemoteHistoryPreview>
  readHistoryVersion?(query: RemoteHistoryQuery): Promise<import('./remote-gateway').RemoteHistoryVersion>
  // Capability lookup: session open only warms a provider that keeps a pool.
  hasCatalogWarmPool?(providerId: string): boolean
  readHistoryTurnsPage?(query: import('./remote-gateway').RemoteHistoryTurnsPageQuery): Promise<import('./remote-gateway').RemoteHistoryTurnsPage>
  listHostAdminNotices?: HostControllerDependencies['listHostAdminNotices']
}

// The file stores require a pre-existing private (0700) directory; create it
// exactly, independent of the process umask.
function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

export async function createHostController(deps: HostControllerFactoryDependencies): Promise<HostControllerBinding> {
  mkdirSync(deps.stateDirectory, { recursive: true })
  const pairingDirectory = privateDir(join(deps.stateDirectory, 'pairing'))
  recoverDeadRemoteLease(pairingDirectory, 'pairing-state.lock')
  const pairingStore = new PairingFileStore(pairingDirectory)
  let ledgerStore: LedgerStore
  let outputStore: RunOutputStore
  try {
    ledgerStore = deps.orchestration?.createLedgerStore() ?? transientLedgerStore
    const outputDirectory = privateDir(join(deps.stateDirectory, 'output'))
    recoverDeadRemoteLease(outputDirectory, 'run-output.lock')
    outputStore = await (deps.createOutputStore?.(outputDirectory) ?? RunOutputWorkerStore.create(outputDirectory))
  } catch (error) {
    pairingStore.close()
    throw error
  }

  const workspace: WorkspaceAuthorizer = { authorize: (cwd) => deps.authorizeWorkspace(cwd) }
  // Opening a session warms that Provider context. Two checks decide: the device
  // grant is already verified by the gateway, and the workspace must pass the same
  // authorization a run needs - starting a Provider inside a repository whose
  // config is not authorized would load repository-controlled code.
  const prewarm = deps.listCommands && deps.hasCatalogWarmPool
    ? createProviderPrewarmer(deps.listCommands, deps.hasCatalogWarmPool)
    : undefined
  const warmSession = prewarm === undefined ? undefined : (target: { providerId: string; cwd?: string; agentProfileId?: string }): void => {
    if (!target.cwd) return
    try { workspace.authorize(target.cwd) } catch { return }
    prewarm(target)
  }
  const controllerDeps: HostControllerDependencies = {
    ...(deps.readDesktop ? { readDesktop: deps.readDesktop } : {}),
    ...(deps.desktopWorkbench ? { desktopWorkbench: deps.desktopWorkbench } : {}),
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
    ...(deps.attachmentStore ? { attachmentStore: deps.attachmentStore } : {}),
    ...(deps.attachmentDirectory ? { attachmentDirectory: deps.attachmentDirectory } : {}),
    runProvider: deps.startRun,
    ...(deps.onDispatchRefused ? { onDispatchRefused: deps.onDispatchRefused } : {}),
    ...(deps.onRunActivity ? { onRunActivity: deps.onRunActivity } : {}),
    ...(deps.onLedgerEvent ? { onLedgerEvent: deps.onLedgerEvent } : {}),
    ...(deps.orchestration ? { orchestration: deps.orchestration } : {}),
    ...(deps.listProjects ? { listProjects: deps.listProjects } : {}),
    ...(deps.listDirectories ? { listDirectories: deps.listDirectories } : {}),
    ...(deps.listProviders ? { listProviders: deps.listProviders } : {}),
    ...(deps.listProvidersFull ? { listProvidersFull: deps.listProvidersFull } : {}),
    ...(deps.listProviderControls ? { listProviderControls: deps.listProviderControls } : {}),
    ...(deps.listCommands ? { listCommands: deps.listCommands } : {}),
    ...(deps.sessionAction ? { sessionAction: deps.sessionAction } : {}),
    ...(deps.sessionFork ? { sessionFork: deps.sessionFork } : {}),
    ...(deps.sessionDelete ? { sessionDelete: deps.sessionDelete } : {}),
    ...(deps.toolPanels ? { toolPanels: deps.toolPanels } : {}),
    ...(deps.listSessions ? { listSessions: deps.listSessions } : {}),
    ...(deps.sessionCatalogRevision ? { sessionCatalogRevision: deps.sessionCatalogRevision } : {}),
    ...(deps.readSessionStatus ? { readSessionStatus: deps.readSessionStatus } : {}),
    ...(deps.macRuns ? { macRuns: deps.macRuns } : {}),
    ...(deps.readHistory ? { readHistory: withPrewarm(deps.readHistory, warmSession) } : {}),
    ...(deps.readHistoryPreview ? { readHistoryPreview: deps.readHistoryPreview } : {}),
    ...(deps.readHistoryVersion ? { readHistoryVersion: deps.readHistoryVersion } : {}),
    ...(deps.readHistoryTurnsPage ? { readHistoryTurnsPage: deps.readHistoryTurnsPage } : {}),
    ...(deps.listHostAdminNotices ? { listHostAdminNotices: deps.listHostAdminNotices } : {})  }

  let controller: HostController
  try {
    controller = new HostController(controllerDeps)
    // Orphaned dispatched runs close as failed (outcome unknown, never re-run);
    // only recorded-but-undispatched intents may start.
    controller.recover()
    await controller.cleanupAttachments()
  } catch (error) {
    try { await outputStore.close() } finally {
      pairingStore.close()
    }
    throw error
  }

  let closed = false
  return {
    controller,
    close: async () => {
      if (closed) return
      closed = true
      // End only desktop-owned shells and ephemeral reads before releasing leases.
      controller.closeReadResources()
      try { await deps.desktopWorkbench?.dispose() } finally {
        try { await outputStore.close() } finally { pairingStore.close() }
      }
    }
  }
}

// Attaches the background warm-up to a session read. The read's own result and
// error travel unchanged: prewarming never turns a successful read into a failed
// one, and never reports a Provider start as session evidence.
function withPrewarm<Q extends { providerId: string; cwd?: string | null; agentProfileId?: string | null }, R>(
  read: (query: Q) => Promise<R>,
  prewarm: ((target: { providerId: string; cwd?: string; agentProfileId?: string }) => void) | undefined
): (query: Q) => Promise<R> {
  if (!prewarm) return read
  return async (query: Q): Promise<R> => {
    const result = await read(query)
    prewarm({
      providerId: query.providerId,
      ...(query.cwd ? { cwd: query.cwd } : {}),
      ...(query.agentProfileId ? { agentProfileId: query.agentProfileId } : {})
    })
    return result
  }
}
