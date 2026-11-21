import { isAgentPermissionMode, type AgentStartRequest } from '../shared/runtime'
import { createProviderDiscovery } from '../main/remote/provider-discovery'
import { listRemoteDirectories, resolveCanonicalRemoteProjectDirectory } from '../main/remote/remote-directory-browser'
import { createHistoryRuntime } from '../main/bootstrap/history-runtime'
import { createForkOperations } from '../main/bootstrap/run-fork'
import type { createSessionState } from '../main/bootstrap/session-state'
import type { createWorkspaceRuntime } from '../main/bootstrap/workspace-runtime'
import type { createSessionCatalog } from '../main/bootstrap/session-catalog'
import type { createPiProfileRuntime } from '../main/bootstrap/pi-profiles'
import type { createProviderRuntime } from '../main/bootstrap/provider-runtime'
import type { createRunPipeline } from '../host-runtime/create-run-pipeline'
import type { RemoteHostRuntime } from '../host-runtime/host-runtime-types'
import type { RemoteHostService } from '../main/remote/remote-host-service'
import type { DesktopRemoteTargetAPI } from '../shared/desktop-remote'
import type { SourceControlService } from '../main/source-control/service'
import type { DaemonSessionLinks } from './local-ops/deps'
import type { BridgedShellOps } from './app-execution-target-bridge'

const unavailable = (capability: string): never => {
  throw new Error(`daemon_capability_unavailable:${capability}`)
}

export interface DaemonRemoteAssemblyDeps {
  userDataDir: string
  workspace: ReturnType<typeof createWorkspaceRuntime>
  pi: ReturnType<typeof createPiProfileRuntime>
  providers: ReturnType<typeof createProviderRuntime>
  session: ReturnType<typeof createSessionState>
  catalog: ReturnType<typeof createSessionCatalog>
  pipeline: ReturnType<typeof createRunPipeline>
  sourceControl: SourceControlService
  remoteRunIds: Set<string>
  requestRunStop: (runId: string) => boolean
  getRemoteHostService: () => RemoteHostService | null
  setRemoteHostService: (value: RemoteHostService | null) => void
  getCurrentCwd: () => string | undefined
  getStartupManagedRecovery: () => Promise<void>
  isShuttingDown: () => boolean
  desktopRemoteClient?: () => DesktopRemoteTargetAPI
  sessionLinks: DaemonSessionLinks
  shellOps?: BridgedShellOps
  log: (line: string) => void
}

/**
 * Builds the daemon's provider discovery, RemoteHostRuntime view, session history
 * channels, and native fork operations over the process's shared stores.
 */
export function createDaemonRemoteAssembly(deps: DaemonRemoteAssemblyDeps) {
  const { workspace, pi, providers, session, catalog, pipeline, sourceControl } = deps
  const configuredRemotePermissionMode = () => {
    const raw = process.env.SCRY_REMOTE_PERMISSION_MODE
    return isAgentPermissionMode(raw) ? raw : undefined
  }
  const providerDiscovery = createProviderDiscovery({
    descriptors: () => providers.providerRegistry.describe(),
    profiles: pi.listPiProfiles,
    resolveProfile: pi.resolvePiProfile,
    authorizeWorkspace: workspace.resolveRemoteProjectDirectory,
    controls: (context) => session.withProviderOperation(
      context.providerId,
      () => providers.providerRegistry.runControls(context),
      context.agentProfileId
    ),
    defaultWorkspace: () => workspace.remoteProjectRoots()[0],
    permissionOverride: configuredRemotePermissionMode,
    supportsForkSession: (providerId) => providers.providerRegistry.get(providerId).forkSession !== undefined,
    onError: (error) => deps.log(`daemon.provider-discovery-failed ${(error as Error)?.message ?? String(error)}`)
  })
  const refreshRemoteProviderSnapshot = () => providerDiscovery.refreshMetadata()

  // Session history pages, loaded and cached in this process (the cache backs older-page
  // reads). The window's session selection is reported with the page for the App to apply.
  const historyChannels: Record<string, (event: unknown, ...args: never[]) => unknown> = {}
  const history = createHistoryRuntime()
  history.register({
    handleTrusted: (channel, listener) => { historyChannels[channel] = listener as unknown as (event: unknown, ...args: never[]) => unknown },
    appSessionStore: catalog.appSessionStore,
    providerContextKey: session.providerContextKey,
    resolveKnownProjectDirectory: workspace.resolveKnownProjectDirectory,
    providerRegistry: providers.providerRegistry,
    getRuns: () => pipeline.runs,
    rememberProject: workspace.rememberProject,
    homeDir: workspace.homeDir,
    userDataDir: deps.userDataDir,
    isShuttingDown: deps.isShuttingDown,
    applySelection: () => undefined,
    reportSelection: true
  })

  // Native fork, as main builds it (index.ts). The daemon has no window selection: a
  // request without a cwd is filled by the App with the window's (session-lifecycle-
  // daemon.ts) and re-resolved here, so getCurrentCwd stays empty on purpose.
  const forkOperations = createForkOperations({
    resolveKnownProjectDirectory: workspace.resolveKnownProjectDirectory,
    providerRegistry: providers.providerRegistry,
    providerOperationGate: session.providerOperationGate,
    contextAdmission: session.contextAdmission,
    providerContextKey: session.providerContextKey,
    unsettledRuns: () => pipeline.runs.unsettledStates(),
    getCurrentCwd: () => undefined,
    getStartupManagedRecovery: deps.getStartupManagedRecovery,
    assertLegacyConversationWriteAllowed: catalog.assertLegacyConversationWriteAllowed,
    resetSessionContext: session.resetSessionContext,
    sessionByContext: session.sessionByContext,
    invalidateSessionHistoryLoad: history.invalidateSessionHistoryLoad,
    appSessionStore: catalog.appSessionStore,
    rememberProject: workspace.rememberProject
  })

  const runtime: RemoteHostRuntime = {
    get remoteHostService() { return deps.getRemoteHostService() },
    set remoteHostService(value) { deps.setRemoteHostService(value) },
    getRemoteProviderDiscovery: () => providerDiscovery,
    refreshRemoteProviderSnapshot,
    configuredRemotePermissionMode,
    remoteStartReceipts: pipeline.remoteStartReceipts,
    startAppRun: (payload: AgentStartRequest, startOptions) => pipeline.startAppRun(payload, startOptions),
    sourceControl,
    providerOperationGate: session.providerOperationGate,
    providerRegistry: providers.providerRegistry,
    runs: pipeline.runs,
    requestRunStop: deps.requestRunStop,
    // W17: reuse daemon's local-ops session lifecycle & native fork with identical remote authority.
    sessionRefFromRequest: (value) => deps.sessionLinks.sessionRefFromRequest ? deps.sessionLinks.sessionRefFromRequest(value) : null,
    changeLegacySessionMetadata: (ref, change) => {
      if (!deps.sessionLinks.changeLegacySessionMetadata) throw new Error('daemon_capability_unavailable:session-metadata')
      return deps.sessionLinks.changeLegacySessionMetadata(ref, change)
    },
    deleteOneSession: (request, options) => {
      if (!deps.sessionLinks.deleteOneSession) throw new Error('daemon_capability_unavailable:session-delete')
      return deps.sessionLinks.deleteOneSession(request as unknown as Record<string, unknown>, options as unknown as Record<string, unknown>)
    },
    forkSessionWithAuthority: (request, authorize) => forkOperations.forkSessionWithAuthority(request, authorize),
    appSessionStore: catalog.appSessionStore,
    knownProjectDirectories: workspace.knownProjectDirectories,
    remoteProjectRoots: workspace.remoteProjectRoots,
    resolveRemoteProjectDirectory: workspace.resolveRemoteProjectDirectory,
    resolveCanonicalRemoteProjectDirectory,
    listRemoteDirectories,
    rememberProject: workspace.rememberProject,
    remoteRunIds: deps.remoteRunIds,
    userQuestionBroker: pipeline.userQuestionBroker,
    withProviderOperation: session.withProviderOperation,
    providerContextKey: session.providerContextKey,
    boundedLiveRun: pipeline.boundedLiveRun,
    getCurrentCwd: deps.getCurrentCwd,
    homeDir: workspace.homeDir,
    openLocalPath: deps.shellOps ? (path) => deps.shellOps!.openPath(path) : async () => unavailable('open-path'),
    ...(deps.desktopRemoteClient ? { desktopRemoteClient: deps.desktopRemoteClient } : {}),
    get isShuttingDown() { return deps.isShuttingDown() }
  }

  return { providerDiscovery, refreshRemoteProviderSnapshot, runtime, history, historyChannels, forkOperations }
}

export function bridgedWorkbenchShellInputs(shellOps: BridgedShellOps) {
  return {
    openPath: shellOps.openPath,
    trashItem: shellOps.trashItem,
    hasOpenPath: shellOps.isAvailable,
    hasTrashItem: shellOps.isAvailable
  }
}

export function disposeProviderRegistryWithTimeout(
  dispose: () => Promise<void>,
  timeoutMs: number,
  log: (line: string) => void
): Promise<void> {
  const boundedTimeoutMs = Math.max(1, timeoutMs)
  return new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      log(`daemon.provider-dispose-timeout timeoutMs=${boundedTimeoutMs}`)
      done()
    }, boundedTimeoutMs)
    timer.unref()
    void dispose().then(done, (error) => {
      log(`daemon.provider-dispose-failed ${(error as Error)?.message ?? String(error)}`)
      done()
    })
  })
}
