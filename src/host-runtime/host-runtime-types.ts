import type { AgentForkSessionResult, AgentPermissionMode, AgentQuestionRequest, AgentQuestionResponse, AgentStartRequest } from '../shared/runtime'
import type { ProviderContext, ProviderId, DeleteSessionResult } from '../shared/provider'
import type { ActiveRun, UsageAnalyticsRangeDays, TraceEvent } from '../shared/trace'
import type { AppSessionRef, createAppSessionStore } from '../main/app-store'
import type { RemoteHostService } from '../main/remote/remote-host-service'
import type { SourceControlService } from '../main/source-control/service'
import type { ProviderRegistry } from '../main/providers/registry'
import type { ProviderOperationGate } from '../main/provider-operation-gate'
import type { DesktopRemoteTargetAPI } from '../shared/desktop-remote'
import type { DesktopRemoteForkSessionRequest } from '../shared/desktop-remote'
import type { UserQuestionBroker } from '../main/user-question'
import type { RemoteRunCompletion } from '../main/remote/remote-run-binding'
import type { RemoteWorkspaceRunStart } from '../main/bootstrap/workspace-start'
import type { SessionDeletionRequest } from '../main/bootstrap/session-lifecycle'
import type { HostControllerFactoryDependencies } from '../main/remote/host-controller-factory'
import type { RemoteHostServiceDependencies } from '../main/remote/remote-host-service-deps'
import type { RemoteRelayResolution } from '../main/bootstrap/remote-relay'

export interface RemoteStartOptions {
  origin: 'remote'
  runId: string
  stopSignal: AbortSignal
  requestUserInput: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>
  ledgerRunId: string
  permissionModeOverride?: AgentPermissionMode
  providerPrompt?: string
  onTraceEvent?: (event: TraceEvent) => void
  onSession?: (id: string) => void
  grantScope?: 'local' | 'remote'
  onRegistered?: (result: { runId: string; externalSessionId?: string; cwd?: string }) => void
}
export type RemoteRuns = {
  activeStates: () => ActiveRun[]
  get: (runId: string) => { state: ActiveRun } | undefined
}
export type DeleteOptions = { confirm: boolean; notifyFailure: boolean; conversationId?: string; runIds?: readonly string[]; authorize?: () => void }

export type RemoteHostRuntime = {
  remoteHostService: RemoteHostService | null
  remoteProviderRefresh?: ReturnType<typeof setInterval>
  getRemoteProviderDiscovery: () => ReturnType<typeof import('../main/remote/provider-discovery').createProviderDiscovery>
  refreshRemoteProviderSnapshot: () => Promise<void>
  configuredRemotePermissionMode: () => AgentPermissionMode | undefined
  startAppRun: (payload: AgentStartRequest, options: RemoteStartOptions) => Promise<RemoteRunCompletion | { runId: string } | RemoteWorkspaceRunStart>
  sourceControl: SourceControlService
  providerOperationGate: ProviderOperationGate
  providerRegistry: ProviderRegistry
  runs: RemoteRuns
  requestRunStop: (runId: string) => boolean
  forkSessionWithAuthority?: (request: DesktopRemoteForkSessionRequest, authorize?: () => void) => Promise<AgentForkSessionResult>
  deleteOneSession?: (request: SessionDeletionRequest, options: DeleteOptions) => Promise<DeleteSessionResult>
  sessionRefFromRequest?: (value: unknown) => AppSessionRef | null
  changeLegacySessionMetadata?: (ref: AppSessionRef, change: () => boolean) => Promise<boolean>
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  knownProjectDirectories: () => Set<string>
  remoteProjectRoots: () => string[]
  resolveRemoteProjectDirectory: (cwd: string) => string
  resolveCanonicalRemoteProjectDirectory: (cwd: string, roots: readonly string[]) => string
  listRemoteDirectories: typeof import('../main/remote/remote-directory-browser').listRemoteDirectories
  rememberProject: (cwd: string) => void
  remoteRunIds: Set<string>
  userQuestionBroker: UserQuestionBroker
  withProviderOperation: <T>(providerId: ProviderId, operation: () => T | Promise<T>, profile?: string) => Promise<T>
  providerContextKey: (providerId: ProviderId, cwd: string, profile?: string) => string
  boundedLiveRun: (run: ActiveRun) => ActiveRun
  getCurrentCwd: () => string | undefined
  homeDir: string
  openLocalPath: (path: string) => Promise<void>
  desktopRemoteClient?: () => DesktopRemoteTargetAPI
  isShuttingDown: boolean
}

export interface HostRuntimeInputs {
  runtime: RemoteHostRuntime
  stateDirectory: string
  userDataDir: string
  relay: RemoteRelayResolution
  gatewayLabel: string
  lan?: { port?: number }
  shellEnvironment: () => Promise<Record<string, string | undefined>>
  openPath?: (path: string) => Promise<void>
  trashItem?: (path: string) => Promise<void>
  hasOpenPath?: () => boolean
  hasTrashItem?: () => boolean
  historyHandlers: Pick<RemoteHostServiceDependencies, 'readHistory' | 'readHistoryPreview' | 'readHistoryVersion' | 'readHistoryTurnsPage'>
  toolPanels: HostControllerFactoryDependencies['toolPanels']
  createOutputStore?: RemoteHostServiceDependencies['createOutputStore']
  localEndpoint?: RemoteHostServiceDependencies['localEndpoint']
  onRunActivity?: (runId: string, intentSeq?: number) => void
  onLedgerEvent?: HostControllerFactoryDependencies['onLedgerEvent']
  orchestration: NonNullable<HostControllerFactoryDependencies['orchestration']>
  listHostAdminNotices?: HostControllerFactoryDependencies['listHostAdminNotices']
  // P8 §5: daemon-side sampler, already scoped to what a remote reader may see.
  readHostMetrics?: HostControllerFactoryDependencies['readHostMetrics']
  managedLaunches?: Pick<import('../main/remote/managed-launches').ManagedLaunches<import('../main/conversation-service-deps').ManagedConversationStart>, 'take' | 'abandon'>
}

export type { UsageAnalyticsRangeDays, ProviderContext }
