import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isAgentPermissionMode, type AgentStartRequest } from '../shared/runtime'
import { configureStorage, initDb } from '../main/db'
import { createSessionState, createMirrorSessionTranscript } from '../main/bootstrap/session-state'
import { createWorkspaceRuntime } from '../main/bootstrap/workspace-runtime'
import { createSessionCatalog } from '../main/bootstrap/session-catalog'
import { createPiProfileRuntime } from '../main/bootstrap/pi-profiles'
import { createProviderRuntime } from '../main/bootstrap/provider-runtime'
import { runStartupRecovery } from '../main/bootstrap/startup-recovery'
import { configureRecorderCliRuntime, warmShellEnv } from '../main/claude-locate'
import { configureRunStageTiming } from '../main/run-stage-timing'
import { daemonPrivateCliPath } from './daemon-config'
import { startRun } from '../main/bootstrap/run-execution'
import { startWorkspaceRun } from '../main/bootstrap/workspace-start'
import { steerObservedRun } from '../main/run-steering'
import { stopObservedBackgroundTask } from '../main/background-task-control'
import { SourceControlService } from '../main/source-control/service'
import { createProviderDiscovery } from '../main/remote/provider-discovery'
import { listRemoteDirectories, resolveCanonicalRemoteProjectDirectory } from '../main/remote/remote-directory-browser'
import { createRemoteHistoryHandlers } from '../main/bootstrap/remote-history'
import { resolveRemoteRelay } from '../main/bootstrap/remote-relay'
import { createRunPipeline } from '../host-runtime/create-run-pipeline'
import { createHostRuntime } from '../host-runtime/host-runtime'
import type { RemoteHostRuntime } from '../host-runtime/host-runtime-types'
import type { RemoteHostService, RemoteHostServiceDependencies } from '../main/remote/remote-host-service'
import { RunOutputWorkerStore } from '../main/remote/run-output-worker'
import { openLocalChannel, type LocalChannel } from './local-channel'
import { localOpHandlersFor, type LocalOpHandler } from '../main/remote/host-local-ops'
import { catalogChannelHandlers, providerControlChannelHandlers, providerDetectionChannelHandlers } from '../main/bootstrap/startup-channels'
import { conversationChannelTable } from '../main/bootstrap/conversation'
import { createDaemonConversationSend } from './conversation-send'
import { createHistoryRuntime } from '../main/bootstrap/history-runtime'
import { resolveSessionRunIds } from '../main/db'
import { deleteConversationHistory } from '../main/conversation-history'
import { localEnrollHandlers, openLocalEnrollSocket, openLocalEnrollmentStore, type LocalEnrollSocket } from './local-enrollment'

export interface DaemonHostProcessOptions {
  userDataDir: string
  daemonStateDirectory: string
  appPath: string
  resourcesPath: string
  appVersion: string
  isPackaged: boolean
  gatewayLabel?: string
  createOutputStore?: RemoteHostServiceDependencies['createOutputStore']
  log?: (line: string) => void
}

export interface DaemonHostProcess {
  service: RemoteHostService
  channel: LocalChannel
  enrollSocket: LocalEnrollSocket
  dispose(): Promise<void>
}

const unavailable = (capability: string): never => {
  throw new Error(`daemon_capability_unavailable:${capability}`)
}

/**
 * Build the same run and host assemblies in a plain Node process. Native UI
 * capabilities are deliberately absent: tool panels return unavailable envelopes,
 * outbound desktop execution is omitted, and shell/session mutation calls fail with
 * named capability errors rather than pretending they succeeded.
 */
export async function createDaemonHostProcess(options: DaemonHostProcessOptions): Promise<DaemonHostProcess> {
  const log = options.log ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  configureRecorderCliRuntime({ resourcesPath: options.resourcesPath, requirePrivateCli: options.isPackaged })
  configureStorage({ userDataDir: options.userDataDir, appPath: options.appPath })
  // Same file the App writes: the two clocks are aligned by performance.timeOrigin,
  // so one run's stages can be read back across both processes.
  configureRunStageTiming(options.userDataDir)
  initDb()

  let isShuttingDown = false
  let currentCwd: string | undefined
  let runSequence = 0
  let startupManagedRecovery: Promise<void> = Promise.resolve()
  let pipeline!: ReturnType<typeof createRunPipeline>
  let remoteHostService: RemoteHostService | null = null

  const mirrorSessionTranscript = createMirrorSessionTranscript(options.userDataDir)
  const session = createSessionState({
    setBadgeCount: () => true,
    publishUnreadSessions: () => undefined
  })

  let loadSessions = (): Array<{ cwd?: string }> => []
  const workspace = createWorkspaceRuntime({
    appUserDataDir: options.userDataDir,
    loadSessions: () => loadSessions()
  })
  const pi = createPiProfileRuntime({ userDataDir: options.userDataDir })
  const providers = createProviderRuntime({
    homeDir: workspace.homeDir,
    userDataDir: options.userDataDir,
    appPath: options.appPath,
    resourcesPath: options.resourcesPath,
    appVersion: options.appVersion,
    isPackaged: options.isPackaged,
    listPiProfiles: pi.listPiProfiles,
    resolvePiProfile: pi.resolvePiProfile
  })

  // The conversation service records its sends as ledger intents (P3-conversation-send.md);
  // the host service exists only later, so the submit resolves it per call.
  const conversationSend = createDaemonConversationSend({
    submit: (peer, input) => {
      if (!remoteHostService) throw new Error('daemon_host_not_ready')
      return remoteHostService.controller.submitIntent(peer, input)
    },
    liveLedgerRunId: (runId) => remoteRunLedgerIds.get(runId)
  })
  const catalog = createSessionCatalog({
    recentStore: workspace.recentStore,
    projectStore: workspace.projectStore,
    userDataDir: options.userDataDir,
    publishDataUpdated: () => undefined,
    unsettledRuns: () => pipeline.runs.unsettledStates(),
    getProviderRegistry: () => providers.providerRegistry,
    forkManagedConversation: async () => unavailable('fork-session'),
    // Only the conversation service starts runs from the catalog, always with a launch.
    startAppRun: (request, startOptions) => startOptions?.managedConversation
      ? conversationSend.startAppRun(request, { managedConversation: startOptions.managedConversation })
      : Promise.reject(new Error('daemon_catalog_start_requires_conversation')),
    homeDir: workspace.homeDir,
    resolveKnownProjectDirectory: workspace.resolveKnownProjectDirectory
  })
  loadSessions = () => catalog.appSessionStore().load()

  const sourceControl = new SourceControlService({
    userData: options.userDataDir,
    authorizeDirectory: workspace.resolveKnownProjectDirectory,
    unsettledDirectories: () => pipeline.runs.unsettledStates().map((run) => run.cwd),
    registeredWorkspaceRun: (runId, cwd) => pipeline.runs.get(runId)?.state.cwd === cwd
  })

  const remoteRunIds = new Set<string>()
  const remoteRunLedgerIds = new Map<string, string>()
  const requestRunStop = (runId: string): boolean => pipeline.requestRunStop(runId)
  pipeline = createRunPipeline({
    renderer: { send: () => undefined, isFocused: () => false },
    rendererCanReceive: () => false,
    activeRunSessionKey: session.activeRunSessionKey,
    dockBadge: session.dockBadge,
    mainEventId: (prefix, runId) => `${prefix}-${runId}-${randomUUID()}`,
    getCurrentCwd: () => currentCwd,
    getStartupManagedRecovery: () => startupManagedRecovery,
    isShuttingDown: () => isShuttingDown,
    nextRunSequence: () => runSequence++,
    sourceControl,
    providerRegistry: providers.providerRegistry,
    resolveKnownProjectDirectory: workspace.resolveKnownProjectDirectory,
    resolveRemoteProjectDirectory: workspace.resolveRemoteProjectDirectory,
    startWorkspaceRun,
    startRun,
    piRunDiagnostics: providers.piRunDiagnostics,
    appSessionStore: catalog.appSessionStore,
    providerOperationGate: session.providerOperationGate,
    providerContextKey: session.providerContextKey,
    providerSessionKey: session.providerSessionKey,
    contextAdmission: session.contextAdmission,
    resetSessionContext: session.resetSessionContext,
    sessionRevisionByContext: session.sessionRevisionByContext,
    sessionByContext: session.sessionByContext,
    sessionAliasesByContext: session.sessionAliasesByContext,
    deletingSessions: session.deletingSessions,
    conversationStore: catalog.conversationStore,
    assertLegacyConversationWriteAllowed: catalog.assertLegacyConversationWriteAllowed,
    recordingBlockedSessions: session.recordingBlockedSessions,
    homeDir: workspace.homeDir,
    sessionDiffBaselines: session.sessionDiffBaselines,
    recordingRecoveryHint: session.recordingRecoveryHint,
    sessionBaselineKey: session.sessionBaselineKey,
    requestRunStop,
    bumpSessionRevision: session.bumpSessionRevision,
    remoteRunIds,
    remoteRunLedgerIds,
    mirrorSessionTranscript
  })

  // Startup recovery owns unfinished recorder/outbox/conversation evidence. The
  // daemon must finish it before exposing local.sock, otherwise a device can start
  // a new run while the previous process is still being reconciled.
  startupManagedRecovery = runStartupRecovery({
    userDataDir: options.userDataDir,
    recorderCli: daemonPrivateCliPath(options.resourcesPath),
    startupPerf: { mark: () => undefined, finish: () => null },
    conversationStore: catalog.conversationStore,
    runs: pipeline.runs,
    deferMs: 0
  })
  await startupManagedRecovery

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
    // The daemon does not yet own the App's session-mutation control plane, so
    // discovery must not advertise a fork operation that the host cannot execute.
    supportsForkSession: () => false,
    onError: (error) => log(`daemon.provider-discovery-failed ${(error as Error)?.message ?? String(error)}`)
  })
  const refreshRemoteProviderSnapshot = () => providerDiscovery.refreshMetadata()

  const runtime: RemoteHostRuntime = {
    get remoteHostService() { return remoteHostService },
    set remoteHostService(value) { remoteHostService = value },
    getRemoteProviderDiscovery: () => providerDiscovery,
    refreshRemoteProviderSnapshot,
    configuredRemotePermissionMode,
    remoteStartReceipts: pipeline.remoteStartReceipts,
    startAppRun: (payload: AgentStartRequest, startOptions) => pipeline.startAppRun(payload, startOptions),
    sourceControl,
    providerOperationGate: session.providerOperationGate,
    providerRegistry: providers.providerRegistry,
    runs: pipeline.runs,
    requestRunStop,
    appSessionStore: catalog.appSessionStore,
    knownProjectDirectories: workspace.knownProjectDirectories,
    remoteProjectRoots: workspace.remoteProjectRoots,
    resolveRemoteProjectDirectory: workspace.resolveRemoteProjectDirectory,
    resolveCanonicalRemoteProjectDirectory,
    listRemoteDirectories,
    rememberProject: workspace.rememberProject,
    remoteRunIds,
    userQuestionBroker: pipeline.userQuestionBroker,
    withProviderOperation: session.withProviderOperation,
    providerContextKey: session.providerContextKey,
    boundedLiveRun: pipeline.boundedLiveRun,
    getCurrentCwd: () => currentCwd,
    homeDir: workspace.homeDir,
    openLocalPath: async () => unavailable('open-path'),
    get isShuttingDown() { return isShuttingDown }
  }

  // The conversation ledger table main registers, built over this process's stores.
  // Only the channels DAEMON_LOCAL_OP_CHANNELS lists are served; the rest of the table
  // (writes that need App-side deletion and run tracking) stays refused until migrated.
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
    userDataDir: options.userDataDir,
    isShuttingDown: () => isShuttingDown,
    applySelection: () => undefined,
    reportSelection: true
  })

  const conversationTable = conversationChannelTable({
    resolveKnownProjectDirectory: workspace.resolveKnownProjectDirectory,
    providerContextKey: session.providerContextKey,
    providerSessionKey: session.providerSessionKey,
    contextAdmission: session.contextAdmission,
    getStartupManagedRecovery: () => startupManagedRecovery,
    appSessionStore: catalog.appSessionStore,
    conversationStore: catalog.conversationStore,
    conversationService: catalog.conversationService,
    assertLegacyConversationWriteAllowed: catalog.assertLegacyConversationWriteAllowed,
    getRuns: () => pipeline.runs,
    providerRegistry: providers.providerRegistry,
    rememberProject: workspace.rememberProject,
    deletingSessions: session.deletingSessions,
    adoptingSessionKeys: session.adoptingSessionKeys,
    // Announcing changes to the App is not built yet (§13.5): a no-op here, never a
    // silent success elsewhere. The history cache invalidated is this daemon's own.
    invalidateSessionHistoryLoad: history.invalidateSessionHistoryLoad,
    publishDataUpdated: () => undefined,
    deleteOneSession: async () => { throw new Error('daemon_capability_unavailable:session-delete') },
    resolveSessionRunIds,
    deleteConversationHistory,
    appUserDataDir: options.userDataDir
  })
  const conversationLocalOps = Object.fromEntries(Object.entries({ ...conversationTable.handlers, ...historyChannels })
    .map(([channel, listener]) => [channel, (...args: unknown[]) => (listener as (event: unknown, ...values: unknown[]) => unknown)(undefined, ...args)]))
  conversationLocalOps['conversation:send'] = conversationSend.answer(conversationLocalOps['conversation:send'] as (request: unknown) => Promise<unknown>)

  // App run controls answer from this process's registry: steering and background-task
  // stops are bound to the live run, so they cannot be replayed from another process.
  const runControl = {
    steer: (payload: unknown) => steerObservedRun(payload, (runId) => pipeline.runs.get(runId)),
    stopBackgroundTask: (payload: unknown) => stopObservedBackgroundTask(payload, (runId) => pipeline.runs.get(runId)),
    adopt: (runId: string) => pipeline.runs.get(runId)?.state ?? null
  }

  await refreshRemoteProviderSnapshot()
  const remoteStateDirectory = join(options.userDataDir, 'remote')
  const relay = await resolveRemoteRelay(remoteStateDirectory)
  const service = await createHostRuntime({
    runtime,
    stateDirectory: remoteStateDirectory,
    userDataDir: options.userDataDir,
    relay,
    gatewayLabel: options.gatewayLabel ?? 'Scry daemon',
    shellEnvironment: warmShellEnv,
    historyHandlers: createRemoteHistoryHandlers(runtime, options.userDataDir),
    // Omit every source. HostController returns explicit unavailable envelopes with
    // reasons for analytics, LLM performance and MCP trust.
    toolPanels: undefined,
    managedLaunches: conversationSend.launches,
    localEndpoint: {
      runControl,
      // The App channels this daemon answers for the App whose runs it owns. Built from
      // the same handler factories Electron main registers, so both answer alike.
      localOps: localOpHandlersFor({
        ...catalogChannelHandlers({
          appSessionStore: catalog.appSessionStore,
          listProjectCatalog: catalog.listProjectCatalog,
          recentStore: workspace.recentStore
        }),
        ...providerDetectionChannelHandlers({
          smokeProviderEnabled: providers.smokeProviderEnabled,
          smokeDetectedAgents: providers.smokeDetectedAgents,
          storedPiProfilesNotDetected: pi.storedPiProfilesNotDetected,
          providerCompatibility: providers.providerCompatibility,
          detectInstalledAgents: pi.detectInstalledAgents,
          providerRegistry: providers.providerRegistry
        }),
        ...providerControlChannelHandlers({ providerRegistry: providers.providerRegistry, withProviderOperation: session.withProviderOperation }),
        ...conversationLocalOps
      } as Record<string, LocalOpHandler>)
    },
    createOutputStore: options.createOutputStore ?? ((directory) => RunOutputWorkerStore.create(
      directory,
      // This expression stays in the daemon entry (out/main/daemon.js), while the
      // worker is another top-level main entry beside it. Supplying it avoids the
      // worker module's default URL, which resolves from its shared chunks file.
      new URL('./run-output-file-worker.js', import.meta.url)
    ))
  })
  remoteHostService = service
  await service.start()
  // The App's own endpoint: same controller and TLS materials, marked as the local
  // transport so a locally enrolled grant cannot be replayed over the network.
  const localHost = service.createLocalHost({ version: options.appVersion })
  const channel = await openLocalChannel({
    directory: options.daemonStateDirectory,
    serve: (stream) => localHost.serve(stream)
  })
  // Enrollment bootstraps the App's grant before it owns any certificate. The secret
  // exists only while no local grant is live and is consumed by a single enrollment.
  const enrollment = openLocalEnrollmentStore(options.daemonStateDirectory)
  enrollment.ensure(service.hasActiveLocalGrant())
  const enrollSocket = await openLocalEnrollSocket({
    directory: options.daemonStateDirectory,
    enroll: localEnrollHandlers(enrollment, {
      enrollLocal: (input, consumeSecret) => service.enrollLocalDevice(input, consumeSecret)
    }, service.caCertificatePEM, options.appVersion)
  })
  log(`daemon.host-ready socket=${channel.socketPath} enroll=${enrollSocket.socketPath}`)

  let disposed = false
  return {
    service,
    channel,
    enrollSocket,
    dispose: async () => {
      if (disposed) return
      disposed = true
      isShuttingDown = true
      startupManagedRecovery = Promise.resolve()
      await enrollSocket.close()
      await channel.close()
      await localHost.close()
      await service.dispose()
    }
  }
}
