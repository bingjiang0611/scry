import { app, BrowserWindow, dialog } from 'electron'
import { packagedRecorderCliPath, warmShellEnv } from './claude-locate'
import { replayDatabaseTurnOutbox, initDb } from './db'
import { cleanupAppStoreAtomicTemps } from './app-store'
import { cleanupUsageAtomicTemps } from './usage-jsonl'
import { cleanupManagedTurnTemps, managedRecoveryScopes, recoverManagedTraceProgress, recoverManagedTraceTurns } from './managed-turn-commit'
import { cleanupTraceArchiveTemps } from './transcript-archive'
import { recoverTraceTurnProgress, cleanupTraceTurnProgressTemps } from './trace-turn-progress'
import { redeliverGrantedCommitHooksAtStartup } from './commit-hook-startup'
import { disposeTranscriptParser } from './transcript-parser'
import { configureProviderEventLog } from './provider-event-log'
import { startPerformanceRecording, stopPerformanceRecording, recordResourcePerformance, recordStartupPerformance, performanceRecordingHealth } from './performance-recording'
import { performanceRecordingEnabled, PerformanceTrace } from './performance-timing'
import { startPerformanceResourceMonitor, type PerformanceResourceMonitor } from './performance-resource-monitor'
import { runWorkflowPreparationGate, settleRunsForShutdown, enforceShutdownDeadline } from './shutdown'
import type { SourceControlService } from './source-control/service'
import type { TerminalManager } from './terminal-manager'
import type { TerminalOutputBridge } from './terminal-output'
import type { TraceOutputBridge } from './trace-output'
import type { SessionDiffBaselineRegistry } from './session-diff'
import type { RunStopLifecycle } from './run-stop-lifecycle'
import type { ShutdownRunControl } from './shutdown'
import type { ProviderRegistry } from './providers/registry'
import type { ConversationStore } from './conversation-store'
import type { WorkflowService } from './workflow-service'
import type { ActiveRun } from '../shared/trace'
import type { ProviderId } from '../shared/provider'
import { workflowShutdownCopy } from '../shared/constants/copy'

export interface AppLifecycleDeps {
  primaryInstance: boolean
  appVersion: string
  isPackaged: boolean
  useDevelopmentRenderer: boolean
  getUserData: () => string
  getWindow: () => BrowserWindow | null
  createWindow: () => void
  setShuttingDown: (value: boolean) => void
  setStartupRecovery: (recovery: Promise<void>) => void
  dockBadge: { sync: () => void }
  traceOutput: TraceOutputBridge
  runs: {
    activeStates: () => ActiveRun[]
    unsettledStates: () => ActiveRun[]
    unsettledControls: () => Array<ShutdownRunControl & { providerId: ProviderId; cwd?: string }>
  }
  terminalOutput: TerminalOutputBridge
  terminalManager: () => TerminalManager | undefined
  runStopLifecycle: RunStopLifecycle
  sessionDiffBaselines: SessionDiffBaselineRegistry
  providerRegistry: ProviderRegistry
  sourceControl: SourceControlService
  conversationStore: () => ConversationStore
  workflowService: WorkflowService
  resolveGrantedManagedCommitHookEnv: (cwd: string) => Promise<NodeJS.ProcessEnv | undefined>
  mirrorSessionTranscript: (providerId: ActiveRun['providerId'], cwd: string | undefined, sessionId: string | undefined) => Promise<void>
  userQuestionBroker: { cancelRun: (runId: string) => void }
  withoutCommitHookCapability: () => NodeJS.ProcessEnv
  disposeRemote: () => Promise<void>
  startRemoteHost: () => void
}

export function registerAppLifecycle(deps: AppLifecycleDeps): { getPerformanceResourceMonitor: () => PerformanceResourceMonitor | null } {
  let performanceResourceMonitor: PerformanceResourceMonitor | null = null
  app.whenReady().then(async () => {
    if (!deps.primaryInstance) return
    const startupPerf = new PerformanceTrace('app.startup', { platform: process.platform }, recordStartupPerformance)
    await startPerformanceRecording(deps.getUserData(), deps.appVersion, deps.isPackaged, deps.useDevelopmentRenderer)
    startupPerf.mark('performance_recording_ready')
    configureProviderEventLog(process.env, deps.getUserData())
    deps.dockBadge.sync()
    void warmShellEnv()
    initDb()
    startupPerf.mark('database_ready')
    deps.createWindow()
    performanceResourceMonitor = startPerformanceResourceMonitor({
      enabled: performanceRecordingEnabled(),
      intervalMs: 5_000,
      sink: recordResourcePerformance,
      getAppMetrics: () => app.getAppMetrics(),
      counters: () => {
        const trace = deps.traceOutput.snapshot()
        return {
          traceBufferedEvents: trace.bufferedEvents,
          traceBufferedBytes: trace.bufferedBytes,
          traceInFlightBytes: trace.inFlightBytes,
          traceSkippedEvents: trace.skippedEvents,
          activeRuns: deps.runs.activeStates().length,
          ...performanceRecordingHealth()
        }
      }
    })
    startupPerf.mark('window_created')
    deps.startRemoteHost()
    deps.setStartupRecovery((async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      await replayDatabaseTurnOutbox()
      startupPerf.mark('recovery_outbox_replayed')
      cleanupAppStoreAtomicTemps(deps.getUserData())
      cleanupUsageAtomicTemps(deps.getUserData())
      cleanupManagedTurnTemps(deps.getUserData())
      cleanupTraceTurnProgressTemps(deps.getUserData())
      await cleanupTraceArchiveTemps(deps.getUserData())
      startupPerf.mark('recovery_temps_cleaned')
      try {
        await deps.conversationStore().recoverAll(new Set(deps.runs.unsettledStates().map((run) => run.runId)))
      } catch (error) {
        console.warn('[scry] conversation startup recovery failed:', error)
      }
      try {
        const traceProgress = await recoverTraceTurnProgress(deps.getUserData(), {
          isLiveManagedRun: (runId) => deps.runs.unsettledStates().some((run) => run.runId === runId)
        })
        if (traceProgress.pending > 0) console.warn('[scry] trace turn progress recovery pending:', traceProgress)
        for (const scope of await managedRecoveryScopes(deps.getUserData())) {
          const commitHookEnv = await deps.resolveGrantedManagedCommitHookEnv(scope.cwd)
          const journals = await recoverManagedTraceTurns(deps.getUserData(), { ...scope, commitHookEnv })
          if (journals.pending > 0) console.warn('[scry] managed turn recovery pending:', scope, journals)
          const progress = await recoverManagedTraceProgress(deps.getUserData(), { ...scope, commitHookEnv })
          if (progress.pending > 0) console.warn('[scry] managed turn progress recovery pending:', scope, progress)
        }
      } catch (error) {
        console.warn('[scry] managed turn startup recovery failed:', error)
      }
      startupPerf.mark('recovery_trace_and_managed_turns')
      try {
        const recorderCli = packagedRecorderCliPath() ?? process.env.SCRY_CLI_PATH
        const redelivery = await redeliverGrantedCommitHooksAtStartup(deps.getUserData(), {
          env: deps.withoutCommitHookCapability(),
          extendCapabilityEnv: () => ({ ...(recorderCli ? { SCRY_CLI_PATH: recorderCli } : {}), SCRY_RECORDER_MANAGED: '1' })
        })
        if (redelivery.errors.length > 0) console.warn('[scry] recorder commit hook startup redelivery failed:', redelivery.errors)
      } catch (error) {
        console.warn('[scry] recorder commit hook startup redelivery failed:', error)
      }
      startupPerf.mark('recovery_commit_hooks_complete')
      startupPerf.mark('recovery_complete')
      startupPerf.finish()
    })())
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) deps.createWindow()
    })
  })

  let quitCleanupStarted = false
  let quitCleanupFinished = false
  app.on('before-quit', (event) => {
    if (!deps.primaryInstance || quitCleanupFinished) return
    event.preventDefault()
    if (quitCleanupStarted) return
    quitCleanupStarted = true
    deps.setShuttingDown(true)
    void runWorkflowPreparationGate({
      prepare: () => deps.workflowService.prepareForShutdown(),
      onVeto: async preparation => {
        const options = preparation.state === 'storage_failure'
          ? { type: 'error' as const, title: workflowShutdownCopy.title, message: workflowShutdownCopy.storageFailure, detail: preparation.reason }
          : preparation.state === 'initialization_failure'
            ? { type: 'error' as const, title: workflowShutdownCopy.title, message: workflowShutdownCopy.initializationFailure, detail: preparation.reason }
            : { type: 'warning' as const, title: workflowShutdownCopy.title, message: workflowShutdownCopy.unconfirmed, detail: `${workflowShutdownCopy.detail(preparation.workflowIds)}\n${preparation.reason}` }
        try {
          const window = deps.getWindow()
          if (window && !window.isDestroyed()) await dialog.showMessageBox(window, options)
          else await dialog.showMessageBox(options)
        } catch (error) { console.warn('[scry] workflow shutdown warning failed:', error) }
        deps.workflowService.cancelShutdownPreparation()
        deps.setShuttingDown(false)
      },
      proceed: async () => {
        deps.workflowService.close()
        const remoteCleanup = deps.disposeRemote()
        deps.terminalOutput.close()
        const terminalCleanup = deps.terminalManager()?.shutdown().catch((error) => console.warn('[scry] terminal shutdown failed:', (error as Error)?.message)) ?? Promise.resolve()
        deps.runStopLifecycle.close()
        deps.traceOutput.close()
        performanceResourceMonitor?.stop()
        performanceResourceMonitor = null
        deps.sessionDiffBaselines.disposeAll()
        const controls = deps.runs.unsettledControls()
        const runCleanup = settleRunsForShutdown(controls, {
          cancelQuestion: (runId) => deps.userQuestionBroker.cancelRun(runId),
          mirror: (run, externalSessionId) => deps.mirrorSessionTranscript(run.providerId, run.cwd, externalSessionId),
          disposeProviders: () => deps.providerRegistry.dispose()
        })
        const cleanup = Promise.all([runCleanup, terminalCleanup, remoteCleanup, disposeTranscriptParser(), deps.sourceControl.dispose()]).then(() => stopPerformanceRecording())
        void enforceShutdownDeadline(cleanup, controls, () => deps.providerRegistry.dispose()).finally(() => {
          quitCleanupFinished = true
          app.quit()
        })
      }
    }).catch(error => {
      quitCleanupStarted = false
      deps.setShuttingDown(false)
      console.warn('[scry] workflow shutdown preparation failed:', error)
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  return { getPerformanceResourceMonitor: () => performanceResourceMonitor }
}
