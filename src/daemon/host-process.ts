import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentDataUpdated } from '../shared/runtime'
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
import { AppEventFeed, DAEMON_WINDOW_NOTICES } from '../main/remote/app-event-feed'
import type { createForkOperations } from '../main/bootstrap/run-fork'
import { remoteHostEnabled } from '../main/remote/remote-defaults'
import { createDaemonTerminalService } from './terminal-service'
import { localEnrollHandlers, openLocalEnrollSocket, openLocalEnrollmentStore } from './local-enrollment'
import { attachDaemonOrchestrationAuthority } from './orchestration-authority'
import { reconcileH1ForOffMode } from './orchestration-off-fallback'
import { attachDaemonOrchestrationShadow } from './orchestration-shadow'
import { parseOrchestrationMode } from '../host-runtime/orchestration/mode'
import { createDaemonRemoteAssembly } from './host-process-assembly'
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
  // What this daemon tells its App that no run read carries (P3f).
  // Its unread set is state: a new or resynchronizing App gets it whole (E1b).
  const events = new AppEventFeed({ state: () => [{ kind: 'attention', snapshot: session.dockBadge.snapshot() }] })
  const publishData = (event: AgentDataUpdated): void => events.append({ kind: 'data', event })
  const session = createSessionState({
    setBadgeCount: () => true,
    publishUnreadSessions: (snapshot) => events.append({ kind: 'attention', snapshot })
  })

  let loadSessions = (): Array<{ cwd?: string }> => []
  const workspace = createWorkspaceRuntime({
    appUserDataDir: options.userDataDir,
    loadSessions: () => loadSessions()
  })
  // The App's terminals (P3-terminal.md). The recording worker sits beside this entry in
  // out/main, like the run output worker below.
  const terminal = createDaemonTerminalService({
    userDataDir: options.userDataDir,
    homeDir: workspace.homeDir,
    recordingWorkerUrl: new URL('./terminal-recording-worker.js', import.meta.url),
    resolveKnownProjectDirectory: workspace.resolveKnownProjectDirectory,
    notify: () => events.append({ kind: 'terminal' }),
    idleMs: () => events.idleMs(),
    log,
    ...options.terminal
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
    // The pipeline's window notices travel on the App event feed. The trace and questions
    // reach the App through its own run reads, so they are not sent twice (W1).
    renderer: {
      send: (channel, payload) => {
        if (channel === 'agent:dataUpdated') publishData(payload as AgentDataUpdated)
        else if (DAEMON_WINDOW_NOTICES.has(channel)) events.append({ kind: 'window', channel, payload })
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
    skipConversationRecovery: parseOrchestrationMode(process.env).effective === 'on'
  })
  await startupManagedRecovery

  const targetBridge = createAppExecutionTargetBridge({
    isPrimaryAppPeer: (fingerprint) => remoteHostService?.authority.isPrimaryAppLocalGrant(fingerprint) ?? false,
    ...(options.executionTargetCallTimeoutMs !== undefined ? { callTimeoutMs: options.executionTargetCallTimeoutMs } : {})
  })
  const { providerDiscovery, refreshRemoteProviderSnapshot, runtime, history, historyChannels, forkOperations: forks } =
    createDaemonRemoteAssembly({
      userDataDir: options.userDataDir,
      workspace,
      pi,
      providers,
      session,
      catalog,
      pipeline,
      sourceControl,
      remoteRunIds,
      requestRunStop,
      getRemoteHostService: () => remoteHostService,
      setRemoteHostService: (value) => { remoteHostService = value },
      getCurrentCwd: () => currentCwd,
      getStartupManagedRecovery: () => startupManagedRecovery,
      isShuttingDown: () => isShuttingDown,
      desktopRemoteClient: () => targetBridge.client,
      log
    })
  forkOperations = forks

  await refreshRemoteProviderSnapshot()
  const remoteStateDirectory = join(options.userDataDir, 'remote')
  reconcileH1ForOffMode({ userDataDir: options.userDataDir, remoteStateDirectory, env: process.env, log })
  const orchestrationShadow = attachDaemonOrchestrationShadow({
    userDataDir: options.userDataDir,
    env: process.env,
    conversationStore: catalog.conversationStore,
    log,
    ...(options.orchestrationShadowBeforeCommitHook ? { beforeCommitHook: options.orchestrationShadowBeforeCommitHook } : {}),
    ...(options.orchestrationShadowPauseBackfill ? { pauseDeferredBackfill: options.orchestrationShadowPauseBackfill } : {})
  })
  const orchestrationAuthority = await attachDaemonOrchestrationAuthority({
    userDataDir: options.userDataDir,
    env: process.env,
    conversationStore: catalog.conversationStore,
    runs: pipeline.runs,
    requestRunStop,
    log,
    ...(options.orchestrationShadowBeforeCommitHook ? { beforeCommitHook: options.orchestrationShadowBeforeCommitHook } : {}),
    ...(options.orchestrationMirrorWriteHook ? { mirrorWriteHook: options.orchestrationMirrorWriteHook } : {}),
    ...(options.orchestrationMirrorMaxPendingEvents !== undefined
      ? { mirrorMaxPendingEvents: options.orchestrationMirrorMaxPendingEvents }
      : {}),
    ...(options.orchestrationMirrorRetryIntervalMs !== undefined
      ? { mirrorRetryIntervalMs: options.orchestrationMirrorRetryIntervalMs }
      : {})
  })
  const hostAdmin = new HostAdminStore({
    stateDirectory: remoteStateDirectory,
    onNotice: (notice) => events.append({ kind: 'hostAdmin', notice })
  })
  const relay = await resolveRemoteRelay(remoteStateDirectory)
  const service = await createHostRuntime({
    runtime,
    stateDirectory: remoteStateDirectory,
    userDataDir: options.userDataDir,
    relay,
    gatewayLabel: options.gatewayLabel ?? 'Scry daemon',
    ...remoteLanConfig(process.env),
    shellEnvironment: warmShellEnv,
    historyHandlers: createRemoteHistoryHandlers(runtime, options.userDataDir),
    // Omit every source. HostController returns explicit unavailable envelopes with
    // reasons for analytics, LLM performance and MCP trust.
    toolPanels: undefined,
    managedLaunches: conversationSend.launches,
    onRunActivity: (runId, intentSeq) => events.append({ kind: 'run', runId, ...(intentSeq !== undefined ? { intentSeq } : {}) }),
    ...(orchestrationShadow ? { onLedgerEvent: orchestrationShadow.onLedgerEvent } : {}),
    ...(orchestrationAuthority ? { orchestration: orchestrationAuthority.hooks } : {}),
    ...(isHostCliExperimentalEnabled(process.env) ? { listHostAdminNotices: () => hostAdmin.recentNotices() } : {}),
    localEndpoint: daemonLocalEndpoint({
      catalog, workspace, providers, pi, session, history, historyChannels, conversationSend, events, terminal,
      runs: () => pipeline.runs,
      requestRunStop,
      forkSessionWithAuthority: (request) => forkOperations!.forkSessionWithAuthority(request),
      remoteHost: () => remoteHostEnabled(process.env.SCRY_REMOTE_HOST, options.isPackaged) ? remoteHostService : null,
      startupManagedRecovery: () => startupManagedRecovery,
      userDataDir: options.userDataDir,
      appVersion: options.appVersion,
      isPackaged: options.isPackaged,
      sourceControl,
      providerDiscovery,
      executionTargetBridge: targetBridge.localHandlers,
      hostAdmin,
      ...(orchestrationAuthority ? { orchestrationStatus: () => orchestrationAuthority.status() } : {}),
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
    activeRuns: () => pipeline.runs.unsettledStates().length
  })
  const channel = await openLocalChannel({
    directory: options.daemonStateDirectory,
    serve: (stream) => localHost.serve(stream)
  })
  orchestrationShadow?.startImport()
  orchestrationAuthority?.startImport()
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
    ...(orchestrationAuthority ? { orchestrationStatus: () => orchestrationAuthority.status() } : {}),
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
    ...(orchestrationShadow ? { orchestrationShadow } : {}),
    ...(orchestrationAuthority ? { orchestrationAuthority } : {}),
    dispose: async () => {
      if (disposed) return
      disposed = true
      isShuttingDown = true
      startupManagedRecovery = Promise.resolve()
      // A parked App long poll answers now instead of holding the channel open.
      events.close()
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
      orchestrationShadow?.close()
      await orchestrationAuthority?.close()
      const disposeTimeoutMs = Math.max(1, options.providerDisposeTimeoutMs ?? 5_000)
      await new Promise<void>((resolve) => {
        let settled = false
        const done = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          log(`daemon.provider-dispose-timeout timeoutMs=${disposeTimeoutMs}`)
          done()
        }, disposeTimeoutMs)
        timer.unref()
        void providers.providerRegistry.dispose().then(done, (error) => {
          log(`daemon.provider-dispose-failed ${(error as Error)?.message ?? String(error)}`)
          done()
        })
      })
    }
  }
}
