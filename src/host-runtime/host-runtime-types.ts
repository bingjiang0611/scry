import type { AgentForkSessionResult, AgentPermissionMode, AgentQuestionRequest, AgentQuestionResponse, AgentStartRequest } from '../shared/runtime'
import type { ProviderContext, ProviderId, DeleteSessionResult } from '../shared/provider'
import type { ActiveRun, UsageAnalyticsRangeDays, TraceEvent } from '../shared/trace'
import type { AppSessionRef, createAppSessionStore } from '../main/app-store'
import type { RemoteHostService } from '../main/remote/remote-host-service'
import type { SourceControlService } from '../main/source-control/service'
import type { ProviderRegistry } from '../main/providers/registry'
import type { ProviderOperationGate } from '../main/provider-operation-gate'
import type { DesktopRemoteClient } from '../main/remote/desktop-client'
import type { DesktopRemoteForkSessionRequest } from '../shared/desktop-remote'
import type { UserQuestionBroker } from '../main/user-question'
import type { RemoteRunCompletion } from '../main/remote/remote-run-binding'
import type { SessionDeletionRequest } from '../main/bootstrap/session-deletion'
import type { HostControllerFactoryDependencies } from '../main/remote/host-controller-factory'
import type { RemoteHostServiceDependencies } from '../main/remote/remote-host-service-deps'
import type { RemoteRelayResolution } from '../main/bootstrap/remote-relay'

// What Electron main supplies to the host assembly. Everything here is either a
// plain value or a function, so the assembly itself needs no Electron API. Main
// keeps the parts only it can do (userData path, shell, app stores, history and
// tool-panel readers) and passes them in.
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
}
export type RemoteRuns = { activeStates: () => ActiveRun[]; get: (runId: string) => { state: ActiveRun } | undefined }
export type RemoteReceipts = { submit: (key: string, task: () => Promise<RemoteRunCompletion>) => Promise<{ result: RemoteRunCompletion }> }
export type DeleteOptions = { confirm: boolean; notifyFailure: boolean; conversationId?: string; runIds?: readonly string[]; authorize?: () => void }

export type RemoteHostRuntime = {
  remoteHostService: RemoteHostService | null
  remoteProviderRefresh?: ReturnType<typeof setInterval>
  getRemoteProviderDiscovery: () => ReturnType<typeof import('../main/remote/provider-discovery').createProviderDiscovery>
  refreshRemoteProviderSnapshot: () => Promise<void>
  configuredRemotePermissionMode: () => AgentPermissionMode | undefined
  remoteStartReceipts: RemoteReceipts
  startAppRun: (payload: AgentStartRequest, options: RemoteStartOptions) => Promise<RemoteRunCompletion | { runId: string }>
  sourceControl: SourceControlService
  providerOperationGate: ProviderOperationGate
  providerRegistry: ProviderRegistry
  runs: RemoteRuns & { subscribe?: (listener: () => void) => () => void }
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
  // Outbound desktop-to-desktop execution is an App capability. A headless daemon
  // that only hosts this machine omits it instead of advertising a throwing target.
  desktopRemoteClient?: () => DesktopRemoteClient
  isShuttingDown: boolean
}

// Only Electron main can produce these: they read the app's own stores and
// modules that import `electron`. Passing them in keeps the assembly free of it.
export interface HostRuntimeInputs {
  runtime: RemoteHostRuntime
  // `<userData>/remote`: identity, pairing, ledger and output state.
  stateDirectory: string
  // The Electron userData directory itself: reader caches and terminal
  // recordings live beside `remote/`, not inside it.
  userDataDir: string
  relay: RemoteRelayResolution
  gatewayLabel: string
  // Lazily resolved login-shell environment for Provider processes.
  shellEnvironment: () => Promise<Record<string, string | undefined>>
  openPath?: (path: string) => Promise<void>
  trashItem?: (path: string) => Promise<void>
  // History readers over the app's transcript archive and SQLite projections.
  historyHandlers: Pick<RemoteHostServiceDependencies, 'readHistory' | 'readHistoryPreview' | 'readHistoryVersion' | 'readHistoryTurnsPage'>
  // Analytics / LLM performance / MCP trust panels.
  toolPanels: HostControllerFactoryDependencies['toolPanels']
  // Test/embedding seam. Production omits it and uses the bounded worker-backed store.
  createOutputStore?: RemoteHostServiceDependencies['createOutputStore']
}

export type { UsageAnalyticsRangeDays, ProviderContext }
