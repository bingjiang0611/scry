import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentDataUpdated } from '../shared/runtime'
import { configureStorage, initDb } from '../main/db'
import { createSessionState, createMirrorSessionTranscript } from '../main/bootstrap/session-state'
import { createWorkspaceRuntime } from '../main/bootstrap/workspace-runtime'
import { createSessionCatalog } from '../main/bootstrap/session-catalog'
import { createPiProfileRuntime } from '../main/bootstrap/pi-profiles'
import { createDaemonProviderRuntime } from './host-provider-runtime'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { runStartupRecovery } from '../main/bootstrap/startup-recovery'
import { configureRecorderCliRuntime, warmShellEnv } from '../main/claude-locate'
import { configureRunStageTiming } from '../main/run-stage-timing'
import { daemonPrivateCliPath } from './daemon-config'
import { startRun } from '../main/bootstrap/run-execution'
import { createHostCheckpointService } from './checkpoint-service'
import { startWorkspaceRun } from '../main/bootstrap/workspace-start'
import { SourceControlService } from '../main/source-control/service'
import { createRemoteHistoryHandlers } from '../main/bootstrap/remote-history'
import { resolveRemoteRelay } from '../main/bootstrap/remote-relay'
import { createRunPipeline } from '../host-runtime/create-run-pipeline'
import { createHostRuntime } from '../host-runtime/host-runtime'
import { remoteLanConfig } from '../main/remote/remote-lan-config'
import type { RemoteHostService } from '../main/remote/remote-host-service'
import { RunOutputWorkerStore } from '../main/remote/run-output-worker'
import { openLocalChannel } from './local-channel'
import { createDaemonConversationSend } from './conversation-send'
import { daemonLocalEndpoint } from './local-endpoint'
import { SUBSCRIBE_RETAINED_WINDOW_NOTICES } from '../shared/orchestration-subscribe'
import type { AppHint } from './orchestration-authority-subscribe'
import type { createForkOperations } from '../main/bootstrap/run-fork'
import { remoteHostEnabled } from '../main/remote/remote-defaults'
import { createDaemonTerminalService } from './terminal-service'
import { localEnrollHandlers, openLocalEnrollSocket, openLocalEnrollmentStore } from './local-enrollment'
import type { DaemonOrchestrationAuthority } from './orchestration-authority'
import { bridgedWorkbenchShellInputs, createDaemonRemoteAssembly } from './host-process-assembly'
import { authoritySubscribeDeps, createAuthorityDetailReader } from './orchestration-authority-subscribe'
import { createDaemonCatalogScans } from './orchestration-catalog-scan'
import { createOrchestrationCatalogAccess } from './orchestration-catalog-access'
import { attachHostProcessOrchestration, disposeProviderRegistryBounded } from './host-process-dispose'
import type { DaemonSessionLinks } from './local-ops/deps'
import { createAppExecutionTargetBridge } from './app-execution-target-bridge'
import { HostAdminStore } from './host-admin-store'
import { attachDaemonHostAdmin } from './host-admin-runtime'
import { isHostCliExperimentalEnabled } from '../shared/experimental-host-cli'
import type { DaemonHostProcess, DaemonHostProcessOptions } from './host-process-types'
import { buildIdentity } from '../shared/build-identity'

export type { DaemonHostProcess, DaemonHostProcessOptions } from './host-process-types'

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
  // New and resynchronizing Apps receive the full unread set (E1b).
  let orchestrationAuthority: DaemonOrchestrationAuthority | undefined
  const publishHint = (hint: AppHint): void => orchestrationAuthority?.publishHint(hint)
  const publishData = (event: AgentDataUpdated): void => publishHint({ kind: 'data', event })
  const session = createSessionState({
    setBadgeCount: () => true,
    publishUnreadSessions: (snapshot) => publishHint({ kind: 'attention', snapshot })
  })

  let loadSessions = (): Array<{ cwd?: string }> => []
  const workspace = createWorkspaceRuntime({
    appUserDataDir: options.userDataDir,
    loadSessions: () => loadSessions()
  })
  const catalogProjection = createOrchestrationCatalogAccess(() => orchestrationAuthority?.sink, log)
  const terminal = createDaemonTerminalService({
    userDataDir: options.userDataDir,
    homeDir: workspace.homeDir,
    recordingWorkerUrl: new URL('./terminal-recording-worker.js', import.meta.url),
    resolveKnownProjectDirectory: workspace.resolveKnownProjectDirectory,
    notify: () => publishHint({ kind: 'terminal' }),
    idleMs: () => orchestrationAuthority?.subscribeHub.idleMs() ?? 0,
    log,
    ...options.terminal
  })
  const pi = createPiProfileRuntime({ userDataDir: options.userDataDir })
  // C1: session lifetime is daemon-owned so the release reason can be stored.
  let userDataAuthority: EventSink | undefined
  const providers = createDaemonProviderRuntime({
    homeDir: workspace.homeDir,
    userDataDir: options.userDataDir,
    appPath: options.appPath,
    resourcesPath: options.resourcesPath,
    appVersion: options.appVersion,
    isPackaged: options.isPackaged,
    listPiProfiles: pi.listPiProfiles,
    resolvePiProfile: pi.resolvePiProfile,
    authority: () => userDataAuthority
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
  let forkOperations: ReturnType<typeof createForkOperations> | undefined
  const catalog = createSessionCatalog({
    recentStore: workspace.recentStore,
    projectStore: workspace.projectStore,
    userDataDir: options.userDataDir,
    publishDataUpdated: publishData,
    unsettledRuns: () => pipeline.runs.unsettledStates(),
    getProviderRegistry: () => providers.providerRegistry,
    // Built below, once the history cache it invalidates exists; resolved per call.
    forkManagedConversation: (input) => {
      if (!forkOperations) throw new Error('daemon_capability_unavailable:fork-session')
      return forkOperations.forkManagedConversation(input)
    },
    // Only the conversation service starts runs from the catalog, always with a launch.
    startAppRun: (request, startOptions) => startOptions?.managedConversation
      ? conversationSend.startAppRun(request, { managedConversation: startOptions.managedConversation })
      : Promise.reject(new Error('daemon_catalog_start_requires_conversation')),
    homeDir: workspace.homeDir,
    resolveKnownProjectDirectory: workspace.resolveKnownProjectDirectory,
    projection: catalogProjection
  })
  loadSessions = () => catalog.appSessionStore().load()

  const sourceControl = new SourceControlService({
    userData: options.userDataDir,
    authorizeDirectory: workspace.resolveKnownProjectDirectory,
    unsettledDirectories: () => pipeline.runs.unsettledStates().map((run) => run.cwd),
    registeredWorkspaceRun: (runId, cwd) => pipeline.runs.get(runId)?.state.cwd === cwd
  })

  const checkpoints = createHostCheckpointService({ sink: () => userDataAuthority, userDataDir: options.userDataDir, log })

  const remoteRunIds = new Set<string>()
  const remoteRunLedgerIds = new Map<string, string>()
  const requestRunStop = (runId: string): boolean => pipeline.requestRunStop(runId)
  pipeline = createRunPipeline({
    observeNativeTranscript: (run) => orchestrationAuthority?.observeNativeTranscript(workspace.homeDir, run),
    // Volatile notices travel on the App subscription; traces and questions reach it through its
    // own run reads, so they are not sent twice (W1).
    renderer: {
      send: (channel, payload) => {
        if (channel === 'agent:dataUpdated') publishData(payload as AgentDataUpdated)
        else if (SUBSCRIBE_RETAINED_WINDOW_NOTICES.has(channel)) publishHint({ kind: 'window', channel, payload })
      },
      isFocused: () => false,
      acceptsNotices: () => true
    },
    rendererCanReceive: () => false,
    activeRunSessionKey: session.activeRunSessionKey,
    dockBadge: session.dockBadge,
    mainEventId: (prefix, runId) => `${prefix}-${runId}-${randomUUID()}`,
    getCurrentCwd: () => currentCwd,
    getStartupManagedRecovery: () => startupManagedRecovery,
    isShuttingDown: () => isShuttingDown,
    nextRunSequence: () => runSequence++,
    sourceControl,
    captureCheckpoint: (input) => checkpoints.capture(input),
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
    deferMs: 0,
    skipConversationRecovery: true
  })
  await startupManagedRecovery

  const sessionLinks: DaemonSessionLinks = {
    deleteNativeProjection: catalogProjection.deleteNative, deleteConversationProjection: catalogProjection.deleteConversation
  }
  const targetBridge = createAppExecutionTargetBridge({
    isPrimaryAppPeer: (fingerprint) => remoteHostService?.authority.isPrimaryAppLocalGrant(fingerprint) ?? false,
    ...(options.executionTargetCallTimeoutMs !== undefined ? { callTimeoutMs: options.executionTargetCallTimeoutMs } : {})
  })
  const { providerDiscovery, refreshRemoteProviderSnapshot, runtime, history, historyChannels, forkOperations: forks } =
    createDaemonRemoteAssembly({
      userDataDir: options.userDataDir, workspace, pi, providers, session, catalog, pipeline, sourceControl, remoteRunIds, requestRunStop,
      readProjectedHistory: catalogProjection.readDetail,
      getRemoteHostService: () => remoteHostService, setRemoteHostService: (value) => { remoteHostService = value },
      getCurrentCwd: () => currentCwd, getStartupManagedRecovery: () => startupManagedRecovery, isShuttingDown: () => isShuttingDown,
      desktopRemoteClient: () => targetBridge.client, sessionLinks, shellOps: targetBridge.shellOps, log,
      // The authority is attached further down, so the fork path reads it lazily.
      getOrchestrationAuthority: () => orchestrationAuthority
    })
  forkOperations = forks

  await refreshRemoteProviderSnapshot()
  const remoteStateDirectory = join(options.userDataDir, 'remote')
  const authority = await attachHostProcessOrchestration({
    options,
    conversationStore: catalog.conversationStore,
    runs: pipeline.runs,
    requestRunStop,
    attentionSnapshot: () => session.dockBadge.snapshot(),
    log
  })
  orchestrationAuthority = authority
  userDataAuthority = authority.sink
  const hostAdmin = new HostAdminStore({
    stateDirectory: remoteStateDirectory,
    onNotice: (notice) => publishHint({ kind: 'hostNotice', notice })
  })
  const relay = await resolveRemoteRelay(remoteStateDirectory)
  const listHostAdminNotices = isHostCliExperimentalEnabled(process.env) ? () => hostAdmin.recentNotices() : undefined
  const service = await createHostRuntime({
    runtime,
    stateDirectory: remoteStateDirectory,
    userDataDir: options.userDataDir,
    relay,
    gatewayLabel: options.gatewayLabel ?? 'Scry daemon',
    ...remoteLanConfig(process.env),
    shellEnvironment: warmShellEnv,
    ...bridgedWorkbenchShellInputs(targetBridge.shellOps),
    historyHandlers: createRemoteHistoryHandlers(runtime, options.userDataDir),
    // Omit every source. HostController returns explicit unavailable envelopes with
    // reasons for analytics, LLM performance and MCP trust.
    toolPanels: undefined,
    managedLaunches: conversationSend.launches,
    onRunActivity: (runId) => publishHint({ kind: 'run', runId }),
    orchestration: authority.hooks,
    ...(listHostAdminNotices ? { listHostAdminNotices } : {}),
    localEndpoint: daemonLocalEndpoint({
      catalog, workspace, providers, pi, session, history, historyChannels, conversationSend, publishHint, terminal,
      runs: () => pipeline.runs,
      requestRunStop,
      forkSessionWithAuthority: (request) => forkOperations!.forkSessionWithAuthority(request),
      remoteHost: () => remoteHostEnabled(process.env.SCRY_REMOTE_HOST, options.isPackaged) ? remoteHostService : null,
      getOrchestrationAuthority: () => orchestrationAuthority,
      startupManagedRecovery: () => startupManagedRecovery,
      userDataDir: options.userDataDir,
      appVersion: options.appVersion,
      isPackaged: options.isPackaged,
      sourceControl, checkpoints, providerDiscovery,
      executionTargetBridge: targetBridge.localHandlers,
      hostAdmin,
      links: sessionLinks,
      orchestrationStatus: () => authority.status(),
      subscribe: authority.createSubscribeHandler({
        ...authoritySubscribeDeps(() => remoteHostService!, workspace.remoteProjectRoots),
        remoteHostNotices: listHostAdminNotices,
        runQuestions: (runId) => pipeline.runs.get(runId)?.state.pendingQuestions,
        readFirstPage: createAuthorityDetailReader(historyChannels, (id) => catalog.conversationService().read(id)),
        scans: createDaemonCatalogScans(authority.sink, options.userDataDir, workspace,
          catalog.appSessionStore, () => publishData({ kind: 'catalog_recovered' }), log)
      }),
      log
    }),
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
  const identity = buildIdentity(options.appVersion)
  const localHost = service.createLocalHost(identity, {
    onPeerDisconnected: (fingerprint) => targetBridge.onPeerDisconnected(fingerprint),
    activeRuns: () => pipeline.runs.unsettledStates().length,
    isPackaged: options.isPackaged,
    subscribe: 1
  })
  const channel = await openLocalChannel({
    directory: options.daemonStateDirectory,
    serve: (stream) => localHost.serve(stream)
  })
  authority.startImport()
  // Enrollment bootstraps the App's grant before it owns any certificate. The secret
  // exists only while no local grant is live and is consumed by a single enrollment.
  const enrollment = openLocalEnrollmentStore(options.daemonStateDirectory)
  enrollment.ensure(service.hasActiveLocalGrant())
  const enrollSocket = await openLocalEnrollSocket({
    directory: options.daemonStateDirectory,
    enroll: localEnrollHandlers(enrollment, {
      enrollLocal: (input, consumeSecret) => service.enrollLocalDevice(input, consumeSecret)
    }, service.caCertificatePEM, identity)
  })
  const adminSocket = await attachDaemonHostAdmin({
    daemonStateDirectory: options.daemonStateDirectory,
    identity,
    appVersion: options.appVersion,
    isPackaged: options.isPackaged,
    hostAdmin,
    remoteHost: () => remoteHostEnabled(process.env.SCRY_REMOTE_HOST, options.isPackaged) ? remoteHostService : null,
    activeRuns: () => pipeline.runs.unsettledStates().length,
    orchestrationStatus: () => authority.status(),
    log
  })
  log(`daemon.host-ready socket=${channel.socketPath} enroll=${enrollSocket.socketPath}${adminSocket ? ` admin=${adminSocket.socketPath}` : ''}`)

  let disposed = false
  return {
    service,
    channel,
    enrollSocket,
    ...(adminSocket ? { adminSocket } : {}),
    hostAdmin,
    providerOperationGate: session.providerOperationGate,
    orchestrationAuthority: authority,
    dispose: async () => {
      if (disposed) return
      disposed = true
      isShuttingDown = true
      startupManagedRecovery = Promise.resolve()
      // A parked App long poll answers now instead of holding the channel open.
      authority.subscribeHub.close()
      targetBridge.close()
      // Shells end with the daemon too; their recordings are finished on the way.
      await terminal.dispose()
      await adminSocket?.close()
      await enrollSocket.close()
      await channel.close()
      await localHost.close()
      await service.dispose()
      // Close shadow first so pending bodies flush and the EXCLUSIVE SQLite lock releases
      // immediately even if a pooled provider process is slow to exit; bound provider dispose.
      await authority.close()
      await providers.providerSessions.closeAll()
      await disposeProviderRegistryBounded(providers.providerRegistry, options.providerDisposeTimeoutMs ?? 5_000, log)
    }
  }
}
