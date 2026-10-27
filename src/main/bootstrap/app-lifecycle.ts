import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveRendererEntryUrl } from '../renderer-security'
import type { ActiveRun } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import { initDb, setBillingEnvProvider } from '../db'
import { warmShellEnv, shellEnv } from '../claude-locate'
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

  const packagedRendererEntryUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const rendererEntryUrl = resolveRendererEntryUrl(
    process.env.ELECTRON_RENDERER_URL,
    packagedRendererEntryUrl,
    app.isPackaged
  )
  const useDevelopmentRenderer = rendererEntryUrl !== packagedRendererEntryUrl
  const isOwnedTestApp = process.env.SCRY_TEST_APP === '1'
  // Chromium 148 (Electron 42) 在辅助功能客户端接入后会走 AXBlockFlowIterator 计算行内邻居，
  // ax_block_flow_iterator.cc:169 的 CHECK_DEREF(box_fragment->Items()) 会把 renderer 直接打死（SIGTRAP），
  // 窗口只剩背景色。关闭该特性让 Blink 回到 AbstractInlineTextBox 路径，绕开崩溃点。
  // 升级 Electron 时复核：上游修复该 CHECK 或移除此特性开关后应删除这里。
  const disabledChromiumFeatures = app.commandLine.getSwitchValue('disable-features')
  app.commandLine.appendSwitch('disable-features',
    [disabledChromiumFeatures, 'AccessibilityBlockFlowIterator'].filter(Boolean).join(','))
  // 上一条把崩溃从 AXBlockFlowIterator 的 CHECK(SIGTRAP) 挤到了相邻的 AbstractInlineTextBox 路径，
  // 该路径仍会崩：AXObject::Serialize → SerializeInlineTextBox → SerializeLineAttributes →
  // AXInlineTextBox::NeighboringOnLine(+0xf8) 对一个 layout object 为空的文本 FragmentItem 解引用（SIGSEGV）。
  // 32 份 .ips 签名一致（Chromium 148.0.7778.280 / Electron 42.10.1）。
  // 上游只在未发布的 Chromium main 里把该函数改回 AXBlockFlowIterator 实现；148/150/152/156 仍是崩溃版本，
  // 所以升级 Electron 不能解决。AXInlineTextBox 只在 AXMode.kInlineTextBoxes 下创建，
  // 关掉 renderer 无障碍后不再构建/序列化 AX 树，崩溃路径不存在。
  // 代价：VoiceOver 等辅助技术读不到 Scry 界面；等 Electron 带上游重构后删除这里并复核。
  app.commandLine.appendSwitch('disable-renderer-accessibility')
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
  mirrorSessionTranscript, providerRegistry, sourceControl
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
