import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveRendererEntryUrl } from '../renderer-security'
import type { ActiveRun } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import { initDb, setBillingEnvProvider } from '../db'
import { warmShellEnv, shellEnv } from '../claude-locate'
import { ensureShellEnv } from '../shell'
import { configureProviderEventLog } from '../provider-event-log'
import { PerformanceTrace, performanceRecordingEnabled } from '../performance-timing'
import { startPerformanceRecording, stopPerformanceRecording, recordResourcePerformance, recordStartupPerformance, performanceRecordingHealth } from '../performance-recording'
import { startPerformanceResourceMonitor, type PerformanceResourceMonitor } from '../performance-resource-monitor'
import { disposeTranscriptParser } from '../transcript-parser'
import { enforceShutdownDeadline, settleRunsForShutdown } from '../shutdown'
import type { DockBadgeState } from '../dock-badge'
import type { TraceOutputBridge } from '../trace-output'
import type { TerminalOutputBridge } from '../terminal-output'
import type { TerminalManager } from '../terminal-manager'
import type { RunRegistry } from '../run-registry'
import type { RunStopLifecycle } from '../run-stop-lifecycle'
import type { RunTraceRouter } from '../run-trace-router'
import type { UserQuestionBroker } from '../user-question'
import type { SessionDiffBaselineRegistry } from '../session-diff'
import type { ConversationStore } from '../conversation-store'
import type { ProviderRegistry } from '../providers/registry'
import type { SourceControlService } from '../source-control/service'
import type { RemoteHostService } from '../remote/remote-host-service'
import type { DesktopRemoteClient } from '../remote/desktop-client'
import { startRemoteHostIfEnabled, type RemoteHostRuntime } from './remote-host'
import type { RunControl } from './run-control'
import { runStartupRecovery } from './startup-recovery'

export function initializeAppEnvironment(__dirname: string, getWindow: () => BrowserWindow | null) {
  // scry 开发期可能从一个父 Claude Code 会话内启动，继承了 CLAUDECODE / CLAUDE_CODE_* /
  // AI_AGENT 等环境变量，会让 SDK 驱动的 claude 子进程认证错乱（误判为嵌套会话 → Not logged in）。
  // 启动时清掉这些继承来的变量，让 SDK 的 cli.js 以干净的用户级环境读本机登录态（Keychain/OAuth）。
  for (const k of Object.keys(process.env)) {
    if (k === 'CLAUDECODE' || k === 'AI_AGENT' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_')) {
      delete process.env[k]
    }
  }
  // Linux 桌面入口不设置 SHELL。登录 shell 采集、Provider CLI 与终端都靠它，
  // 缺失时回退到 zsh 会让 Arch/Omarchy 上的环境采集直接失败。
  ensureShellEnv()

  const packagedRendererEntryUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const rendererEntryUrl = resolveRendererEntryUrl(
    process.env.ELECTRON_RENDERER_URL,
    packagedRendererEntryUrl,
    app.isPackaged
  )
  const useDevelopmentRenderer = rendererEntryUrl !== packagedRendererEntryUrl
  const isOwnedTestApp = process.env.SCRY_TEST_APP === '1'
  if (process.platform === 'darwin') {
    // Electron 42 / Chromium 148 的两条 inline-text-box 邻居计算路径都已有原生崩溃证据。
    // disable-renderer-accessibility 只挡平台自动激活；macOS AXManualAccessibility / VoiceOver
    // 的 ScopedAccessibilityMode 仍可重新开启 inlineTextBoxes。过滤这类平台 mode，改由 App
    // 提供保留文本、控件和屏幕阅读器语义的 mode，不构建有问题的逐字符布局节点。
    // 限制：逐字符几何/文本标记能力不可用；这不是关闭整个无障碍树。DevTools 显式 AX mode
    // 不属于平台激活，不能用它验证此保护。Electron 修复两条路径后，以原生 AX 回归验证再移除。
    app.commandLine.appendSwitch('disable-platform-accessibility-integration')
    app.once('ready', () => {
      app.setAccessibilitySupportFeatures(['nativeAPIs', 'webContents', 'extendedProperties', 'html', 'screenReader'])
    })
  }
  // Isolated automation stays hidden: showInactive still displays a native window.
  if (isOwnedTestApp && process.platform === 'darwin') app.setActivationPolicy('prohibited')
  const primaryInstance = isOwnedTestApp || app.requestSingleInstanceLock()
  if (!primaryInstance) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      const win = getWindow()
      if (isOwnedTestApp || !win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
  }
  setBillingEnvProvider(shellEnv)
  return { rendererEntryUrl, useDevelopmentRenderer, isOwnedTestApp, primaryInstance }
}

export function registerAppLifecycle({
  primaryInstance, useDevelopmentRenderer, dockBadge, createWindow, traceOutput, runs,
  remoteHostRuntime, requireDesktopRemoteClient, setStartupManagedRecovery, conversationStore,
  beginShutdown, getRemoteHostService, getDesktopRemoteClient, terminalOutput,
  getTerminalManagerInstance, runStopLifecycle, sessionDiffBaselines, userQuestionBroker,
  mirrorSessionTranscript, providerRegistry, sourceControl, runTraces
}: {
  primaryInstance: boolean
  useDevelopmentRenderer: boolean
  dockBadge: DockBadgeState
  createWindow: () => void
  traceOutput: TraceOutputBridge
  runs: RunRegistry<ActiveRun, RunControl>
  remoteHostRuntime: RemoteHostRuntime
  requireDesktopRemoteClient: () => DesktopRemoteClient
  setStartupManagedRecovery: (recovery: Promise<void>) => void
  conversationStore: () => ConversationStore
  beginShutdown: () => void
  getRemoteHostService: () => RemoteHostService | null
  getDesktopRemoteClient: () => DesktopRemoteClient | null
  terminalOutput: TerminalOutputBridge
  getTerminalManagerInstance: () => TerminalManager | undefined
  runStopLifecycle: RunStopLifecycle
  runTraces: RunTraceRouter
  sessionDiffBaselines: SessionDiffBaselineRegistry
  userQuestionBroker: UserQuestionBroker
  mirrorSessionTranscript: (providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined) => Promise<void>
  providerRegistry: ProviderRegistry
  sourceControl: SourceControlService
}): void {
  let performanceResourceMonitor: PerformanceResourceMonitor | null = null

  app.whenReady().then(async () => {
    if (!primaryInstance) return
    const startupPerf = new PerformanceTrace('app.startup', { platform: process.platform }, recordStartupPerformance)
    await startPerformanceRecording(app.getPath('userData'), app.getVersion(), app.isPackaged, useDevelopmentRenderer)
    startupPerf.mark('performance_recording_ready')
    // 双流事件日志按环境变量装配；未设置时 openProviderEventWriter() 返回 undefined。
    configureProviderEventLog(process.env, app.getPath('userData'))
    dockBadge.sync()
    void warmShellEnv()
    // SQLite 是 turn 分析事实的写入前置条件；在 renderer 可发送前完成初始化，
    // 避免快速完成的首轮落过 archive 却永久缺少 spans/usage/intervention。
    initDb()
    startupPerf.mark('database_ready')
    createWindow()
    performanceResourceMonitor = startPerformanceResourceMonitor({
      enabled: performanceRecordingEnabled(),
      intervalMs: 5_000,
      sink: recordResourcePerformance,
      getAppMetrics: () => app.getAppMetrics(),
      counters: () => {
        const trace = traceOutput.snapshot()
        return {
          traceBufferedEvents: trace.bufferedEvents,
          traceBufferedBytes: trace.bufferedBytes,
          traceInFlightBytes: trace.inFlightBytes,
          traceSkippedEvents: trace.skippedEvents,
          activeRuns: runs.activeStates().length,
          ...performanceRecordingHealth()
        }
      }
    })
    startupPerf.mark('window_created')
    void startRemoteHostIfEnabled(remoteHostRuntime)
    // Outbound restoration is independent of inbound hosting and never gates the
    // first window. It only reconnects paired hosts; it does not submit work.
    void requireDesktopRemoteClient().restoreConnections().catch((error) => {
      console.warn('[scry] desktop connection startup recovery failed:', error)
    })
    setStartupManagedRecovery(runStartupRecovery({ startupPerf, conversationStore, runs }))
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  let quitCleanupStarted = false
  let quitCleanupFinished = false
  app.on('before-quit', (event) => {
    if (!primaryInstance || quitCleanupFinished) return
    event.preventDefault()
    if (quitCleanupStarted) return
    beginShutdown()
    quitCleanupStarted = true
    // Release the remote subsystem's durable leases; a restart re-acquires and
    // replays any recorded-but-undispatched intents.
    const remoteCleanup = Promise.all([getRemoteHostService()?.dispose(), getDesktopRemoteClient()?.dispose()]).then(() => undefined)
    terminalOutput.close()
    const terminalCleanup = getTerminalManagerInstance()?.shutdown().catch((error) => {
      console.warn('[scry] terminal shutdown failed:', (error as Error)?.message)
    }) ?? Promise.resolve()
    runStopLifecycle.close()
    traceOutput.close()
    // scoped 流与 legacy 桥一同关闭：订阅、额度与定时器都不留到下一个进程。
    runTraces.close()
    performanceResourceMonitor?.stop()
    performanceResourceMonitor = null
    sessionDiffBaselines.disposeAll()
    const controls = runs.unsettledControls()
    const runCleanup = settleRunsForShutdown(controls, {
      cancelQuestion: (runId) => userQuestionBroker.cancelRun(runId),
      mirror: (run, externalSessionId) => mirrorSessionTranscript(run.providerId, run.cwd, externalSessionId),
      disposeProviders: () => providerRegistry.dispose()
    })
    const cleanup = Promise.all([runCleanup, terminalCleanup, remoteCleanup, disposeTranscriptParser(), sourceControl.dispose()]).then(() => stopPerformanceRecording())
    void enforceShutdownDeadline(cleanup, controls, () => providerRegistry.dispose()).finally(() => {
      quitCleanupFinished = true
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
