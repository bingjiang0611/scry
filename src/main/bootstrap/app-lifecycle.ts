import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveRendererEntryUrl } from '../renderer-security'
import type { ActiveRun } from '../../shared/trace'
import { configureRunStageTiming } from '../run-stage-timing'
import { ensureShellEnv } from '../shell'
import { PerformanceTrace, performanceRecordingEnabled } from '../performance-timing'
import { startPerformanceRecording, stopPerformanceRecording, recordResourcePerformance, recordStartupPerformance, performanceRecordingHealth } from '../performance-recording'
import { startPerformanceResourceMonitor, type PerformanceResourceMonitor } from '../performance-resource-monitor'
import { enforceShutdownDeadline } from '../shutdown'
import type { DockBadgeState } from '../dock-badge'
import type { TraceOutputBridge } from '../trace-output'
import type { RunRegistry } from '../run-registry'
import type { RunStopLifecycle } from '../run-stop-lifecycle'
import type { RunTraceRouter } from '../run-trace-router'
import type { DesktopRemoteClient } from '../remote/desktop-client'
import type { RunControl } from './run-control'
import { shutdownDaemonTerminals } from './terminal-daemon'
import { applyLinuxPasswordStore } from './linux-password-store'

// The App process does window, UI and OS work only. The background service (src/daemon)
// owns userData: scry.db, the ledgers, startup recovery, Providers, terminals and paired
// devices. Nothing here opens or recovers any of it.

export function initializeAppEnvironment(__dirname: string, getWindow: () => BrowserWindow | null) {
  // scry 开发期可能从一个父 Claude Code 会话内启动，继承了 CLAUDECODE / CLAUDE_CODE_* /
  // AI_AGENT 等环境变量；App 直接拉起的后台服务继承这里的环境，会让它的 claude 子进程认证错乱
  // （误判为嵌套会话 → Not logged in）。启动时清掉这些继承来的变量。
  for (const k of Object.keys(process.env)) {
    if (k === 'CLAUDECODE' || k === 'AI_AGENT' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_')) {
      delete process.env[k]
    }
  }
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
  const passwordStore = applyLinuxPasswordStore(app.commandLine)
  if (passwordStore) console.info(`[scry] safeStorage: --password-store=${passwordStore} (desktop not recognised by Chromium)`)
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
  return { rendererEntryUrl, useDevelopmentRenderer, isOwnedTestApp, primaryInstance }
}

export function registerAppLifecycle({
  primaryInstance, useDevelopmentRenderer, dockBadge, createWindow, traceOutput, runs,
  requireDesktopRemoteClient, beginShutdown, getDesktopRemoteClient, runStopLifecycle, runTraces
}: {
  primaryInstance: boolean
  useDevelopmentRenderer: boolean
  dockBadge: DockBadgeState
  createWindow: () => void
  traceOutput: TraceOutputBridge
  runs: RunRegistry<ActiveRun, RunControl>
  requireDesktopRemoteClient: () => DesktopRemoteClient
  beginShutdown: () => void
  getDesktopRemoteClient: () => DesktopRemoteClient | null
  runStopLifecycle: RunStopLifecycle
  runTraces: RunTraceRouter
}): void {
  let performanceResourceMonitor: PerformanceResourceMonitor | null = null

  app.whenReady().then(async () => {
    if (!primaryInstance) return
    const startupPerf = new PerformanceTrace('app.startup', { platform: process.platform }, recordStartupPerformance)
    await startPerformanceRecording(app.getPath('userData'), app.getVersion(), app.isPackaged, useDevelopmentRenderer)
    startupPerf.mark('performance_recording_ready')
    // 首 token 分段计时（SCRY_RUN_TIMING=1 时开启）；与 daemon 写同一目录下的 NDJSON，
    // 两条链路因此可以用同一把墙钟对齐。
    configureRunStageTiming(app.getPath('userData'))
    dockBadge.sync()
    startupPerf.mark('database_owned_by_daemon')
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
    // Outbound restoration never gates the first window. It only reconnects paired
    // hosts; it does not submit work.
    void requireDesktopRemoteClient().restoreConnections().catch((error) => {
      console.warn('[scry] desktop connection startup recovery failed:', error)
    })
    // The daemon recovers its own userData. Record that instead of recovery stages the
    // App never runs, so the startup trace does not claim them.
    startupPerf.mark('recovery_owned_by_daemon')
    startupPerf.finish()
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
    // The desktop client's durable leases; a restart re-acquires them.
    const remoteCleanup = Promise.resolve(getDesktopRemoteClient()?.dispose()).then(() => undefined)
    // The App's shells live in the daemon and end with the App (bounded).
    const terminalCleanup = shutdownDaemonTerminals()
    runStopLifecycle.close()
    traceOutput.close()
    // scoped 流与 legacy 桥一同关闭：订阅、额度与定时器都不留到下一个进程。
    runTraces.close()
    performanceResourceMonitor?.stop()
    performanceResourceMonitor = null
    const cleanup = Promise.all([terminalCleanup, remoteCleanup]).then(() => stopPerformanceRecording())
    void enforceShutdownDeadline(cleanup, [], () => undefined).finally(() => {
      quitCleanupFinished = true
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
