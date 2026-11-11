import type { DesktopRemoteContext, DesktopRemoteSessionAction, DesktopRemoteTargetAPI } from '../../shared/desktop-remote'
import type { HostControllerFactoryDependencies } from './host-controller-factory'
import type { RemoteIntentRouting, RemoteProjectRef, RemoteDirectoryListing, RemoteProviderRef, RemoteCommandCatalog, RemoteCommandQuery, RemoteSessionRef, RemoteHistoryTurn, RemoteHistoryQuery, RemoteHistoryPreview } from './host-controller'
import type { RelayTransport } from './relay-client'
import type { RunOutputStore } from './run-output-log'
import type { ProviderOperationGate } from '../provider-operation-gate'

// Everything the remote host subsystem needs from the app. Re-exported by
// remote-host-service.ts, which composes it.
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
  startRun(input: {
    runId: string
    routing: RemoteIntentRouting
    progress(detail?: string): void
    output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
  }): Promise<void>
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
  readHistory?(query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]>
  readHistoryPreview?(query: RemoteHistoryQuery): Promise<RemoteHistoryPreview>
  readHistoryVersion?(query: RemoteHistoryQuery): Promise<import('./remote-gateway').RemoteHistoryVersion>
  readHistoryTurnsPage?(query: import('./remote-gateway').RemoteHistoryTurnsPageQuery): Promise<import('./remote-gateway').RemoteHistoryTurnsPage>
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
