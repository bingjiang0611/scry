import { join } from 'node:path'
import type { DesktopRemoteContext, DesktopRemoteSessionAction, DesktopRemoteTargetAPI } from '../../shared/desktop-remote'
import type { HostControllerFactoryDependencies } from './host-controller-factory'
import type { HostIdentity } from './host-identity'
import type { RemoteProjectRef, RemoteDirectoryListing, RemoteProviderRef, RemoteCommandCatalog, RemoteCommandQuery, RemoteSessionRef, RemoteHistoryTurn, RemoteHistoryQuery, RemoteHistoryPreview } from './host-controller'
import type { RelayTransport } from './relay-client'
import type { RunOutputStore } from './run-output-log'
import type { ProviderOperationGate } from '../provider-operation-gate'
import type { LocalEndpointHandlers } from './host-local-ops'

// What Electron main supplies to RemoteHostService. Kept apart from the service
// lifecycle so the contract can be read on its own.
export interface RemoteHostServiceDependencies {
  // Direct route for paired phones on the same network. Bootstrap passes it by
  // default (maintainer decision on bingjiang0611/scry#52; SCRY_REMOTE_LAN=0
  // turns it off); absent here means no listener, e.g. in tests.
  lan?: { port?: number; host?: string }
  readDesktop?: HostControllerFactoryDependencies['readDesktop']
  desktopWorkbench?: import('./desktop-workbench').DesktopWorkbenchHost
  desktopDirectories?: HostControllerFactoryDependencies['desktopDirectories']
  // Directory under Scry userData; identity/pairing/ledger subdirs live here.
  stateDirectory: string
  // Maps a device-requested cwd to an already directory-picker-authorized
  // workspace, or throws. A device can never smuggle an unlisted path.
  authorizeWorkspace(cwd: string): string
  // Delegates a fully-authorized remote intent to the live run-start path.
  startRun: HostControllerFactoryDependencies['startRun']
  onDispatchRefused?: HostControllerFactoryDependencies['onDispatchRefused']
  onRunActivity?: HostControllerFactoryDependencies['onRunActivity']
  onLedgerEvent?: HostControllerFactoryDependencies['onLedgerEvent']
  orchestration?: HostControllerFactoryDependencies['orchestration']
  // Snapshot of the host's already directory-picker-authorized project dirs, so
  // the phone's new-session picker chooses only among real authorized targets.
  // Absent => the device sees an honest empty list.
  listProjects?(): RemoteProjectRef[]
  listDirectories?(path?: string): RemoteDirectoryListing
  listProviders?(): RemoteProviderRef[]
  listProvidersFull?(): Promise<RemoteProviderRef[]>
  listProviderControls?(query: Extract<import('../../shared/desktop-remote').RemoteProviderQuery, { detail: 'selected' }>): Promise<RemoteProviderRef>
  listCommands?(query: RemoteCommandQuery): Promise<RemoteCommandCatalog>
  sessionAction?: (context: DesktopRemoteContext, action: DesktopRemoteSessionAction, authorize: () => void) => Promise<boolean> | boolean
  sessionFork?: HostControllerFactoryDependencies['sessionFork']
  sessionDelete?: HostControllerFactoryDependencies['sessionDelete']
  toolPanels?: HostControllerFactoryDependencies['toolPanels']
  listSessions?(): RemoteSessionRef[]
  sessionCatalogRevision?(): string
  readSessionStatus?: HostControllerFactoryDependencies['readSessionStatus']
  macRuns?: HostControllerFactoryDependencies['macRuns']
  // App-only work: run controls over this process's registry (steer, stop one
  // background task, adopt after reconnect) and the App channels it answers (local
  // ops). Served on the local endpoint only.
  localEndpoint?: LocalEndpointHandlers
  readHistory?(query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]>
  readHistoryPreview?(query: RemoteHistoryQuery): Promise<RemoteHistoryPreview>
  readHistoryVersion?(query: RemoteHistoryQuery): Promise<import('./remote-gateway').RemoteHistoryVersion>
  // Capability lookup: session open only warms a provider that keeps a pool.
  hasCatalogWarmPool?(providerId: string): boolean
  readHistoryTurnsPage?(query: import('./remote-gateway').RemoteHistoryTurnsPageQuery): Promise<import('./remote-gateway').RemoteHistoryTurnsPage>
  listHostAdminNotices?: HostControllerFactoryDependencies['listHostAdminNotices']
  // The app-wide gate, so remote runs share auth-vs-run mutual exclusion.
  gate: ProviderOperationGate
  createOutputStore?(directory: string): RunOutputStore | Promise<RunOutputStore>
  // Lazy access keeps the existing desktop client composition dormant until a
  // target request actually needs it.
  desktopRemoteClient?: () => DesktopRemoteTargetAPI
  gatewayLabel?: string
  // How to reach the relay (deployed ws/net connector). Absent => dormant. Called
  // once per mode ('run' for the granted-device mTLS host, 'pair' for the pairing
  // prove endpoint), so the relay keeps a separate warm pool per mode. The
  // context carries the stable hostId + anchor the relay routes/authenticates by.
  createTransport?: (ctx: { hostId: string; anchorSHA256: string; mode: 'run' | 'pair' }) => RelayTransport
  // The device-facing coordinates of the SAME relay, embedded in the scannable
  // pairing code so the phone can reach this host. For a public wss relay
  // (Cloudflare) this is { host: '<name>.workers.dev', port: 443, tls: 'system' };
  // a local dev relay uses tls: 'plaintext'. Absent => no device code is emitted.
  relayAdvertisement?: { host: string; port: number; tls: 'system' | 'plaintext' }
}

// The controller's share of what main supplies: the host identity's keys plus every
// optional source passed through as given (absent stays absent, never a stub).
export function hostControllerDependencies(
  deps: RemoteHostServiceDependencies,
  identity: Pick<HostIdentity, 'hostId' | 'anchorSHA256' | 'verifyCSR' | 'issue'>
): HostControllerFactoryDependencies {
  return {
    stateDirectory: deps.stateDirectory,
    ...(deps.readDesktop ? { readDesktop: deps.readDesktop } : {}),
    ...(deps.desktopWorkbench ? { desktopWorkbench: deps.desktopWorkbench } : {}),
    ...(deps.desktopDirectories ? { desktopDirectories: deps.desktopDirectories } : {}),
    hostId: identity.hostId,
    anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR,
    issue: identity.issue,
    authorizeWorkspace: deps.authorizeWorkspace,
    startRun: deps.startRun,
    ...(deps.onDispatchRefused ? { onDispatchRefused: deps.onDispatchRefused } : {}),
    ...(deps.onRunActivity ? { onRunActivity: deps.onRunActivity } : {}),
    ...(deps.onLedgerEvent ? { onLedgerEvent: deps.onLedgerEvent } : {}),
    ...(deps.orchestration ? { orchestration: deps.orchestration } : {}),
    gate: deps.gate,
    attachmentDirectory: join(deps.stateDirectory, 'attachments'),
    ...(deps.createOutputStore ? { createOutputStore: deps.createOutputStore } : {}),
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
    ...(deps.readHistory ? { readHistory: deps.readHistory } : {}),
    ...(deps.readHistoryPreview ? { readHistoryPreview: deps.readHistoryPreview } : {}),
    ...(deps.readHistoryVersion ? { readHistoryVersion: deps.readHistoryVersion } : {}),
    ...(deps.hasCatalogWarmPool ? { hasCatalogWarmPool: deps.hasCatalogWarmPool } : {}),
    ...(deps.readHistoryTurnsPage ? { readHistoryTurnsPage: deps.readHistoryTurnsPage } : {}),
    ...(deps.listHostAdminNotices ? { listHostAdminNotices: deps.listHostAdminNotices } : {})
  }
}
