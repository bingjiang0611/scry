import { BrowserWindow, dialog, Menu, shell } from 'electron'
import { join } from 'node:path'
import { configureRendererPermissions, isAllowedRendererRequest, isSafeExternalUrl, isTrustedRendererUrl, rendererContentSecurityPolicy } from '../renderer-security'
import { windowBackgroundColor, windowTitleBarOptions } from '../window-chrome'
import { shouldShowEditContextMenu, shouldShowImageContextMenu, editContextMenuTemplate, imageContextMenuTemplate } from '../edit-context-menu'
import type { TerminalOutputBridge } from '../terminal-output'
import type { TraceOutputBridge } from '../trace-output'
import type { DockBadgeState } from '../dock-badge'

export interface WindowBootstrapDependencies {
  __dirname: string
  rendererEntryUrl: string
  useDevelopmentRenderer: boolean
  isOwnedTestApp: boolean
  getWindow: () => BrowserWindow | null
  setWindow: (window: BrowserWindow | null) => void
  terminalOutput: TerminalOutputBridge
  traceOutput: TraceOutputBridge
  dockBadge: DockBadgeState
  isShuttingDown: () => boolean
  rendererAutoReloadCooldownMs: number
}

export function createWindow(deps: WindowBootstrapDependencies): void {
  const {
    __dirname, rendererEntryUrl, useDevelopmentRenderer, isOwnedTestApp, getWindow, setWindow,
    terminalOutput, traceOutput, dockBadge, isShuttingDown, rendererAutoReloadCooldownMs
  } = deps
  setWindow(new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 860,
    title: 'Scry',
    show: false,
    backgroundColor: windowBackgroundColor('dark'),
    ...windowTitleBarOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Background fixtures still need real animation frames and bounded UI waits.
      backgroundThrottling: !isOwnedTestApp
    }
  }))
  const createdWindow = getWindow()!
  createdWindow.on('focus', () => {
    // A completion received while the app was in the background is considered
    // read once its already-selected conversation becomes visible again.
    // DockBadgeState clears only that conversation and preserves other unread runs.
    dockBadge.focusWindow()
  })
  createdWindow.on('closed', () => {
    terminalOutput.detachRenderer()
    // renderer 消失后没人再 ACK 在途 trace 字节；不清零会让下一个窗口永久卡在 high-water。
    traceOutput.reset()
    if (getWindow() === createdWindow) setWindow(null)
  })
  createdWindow.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    terminalOutput.detachRenderer()
    traceOutput.reset()
  })
  // Renderer 崩溃后窗口不会自己恢复，只剩背景色（黑屏）。自动重载一次；冷却期内再次崩溃说明
  // 可能是确定性崩溃，改为询问用户，避免无限重载循环。重载后 app:rendererReady 会重新驱动 trace 投递。
  let lastRendererAutoReloadAt = Number.NEGATIVE_INFINITY
  createdWindow.webContents.on('render-process-gone', (_event, details) => {
    terminalOutput.detachRenderer()
    traceOutput.reset()
    console.error(`[scry] renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`)
    if (details.reason === 'clean-exit' || isShuttingDown() || createdWindow.isDestroyed()) return
    const now = Date.now()
    if (now - lastRendererAutoReloadAt >= rendererAutoReloadCooldownMs) {
      lastRendererAutoReloadAt = now
      createdWindow.webContents.reload()
      return
    }
    void dialog.showMessageBox(createdWindow, {
      type: 'error',
      message: '界面进程反复崩溃',
      detail: `原因：${details.reason}（exit ${details.exitCode}）。`,
      buttons: ['重新加载', '关闭窗口'],
      defaultId: 0,
      cancelId: 1
    }).then(({ response }) => {
      if (createdWindow.isDestroyed()) return
      if (response === 0) {
        lastRendererAutoReloadAt = Date.now()
        createdWindow.webContents.reload()
      } else {
        createdWindow.close()
      }
    })
  })
  getWindow()!.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[scry] preload failed: ${preloadPath}`, error)
  })
  const rendererSession = getWindow()!.webContents.session
  configureRendererPermissions(rendererSession, rendererEntryUrl)
  rendererSession.webRequest.onBeforeRequest((details, callback) => {
    callback(isAllowedRendererRequest(details.url, rendererEntryUrl) ? {} : { cancel: true })
  })
  rendererSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [rendererContentSecurityPolicy(rendererEntryUrl)]
      }
    })
  })
  getWindow()!.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, rendererEntryUrl)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
  getWindow()!.webContents.on('will-redirect', (event, url) => {
    if (isTrustedRendererUrl(url, rendererEntryUrl)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
  getWindow()!.webContents.on('will-attach-webview', (event) => event.preventDefault())
  getWindow()!.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  let windowShown = false
  const onIpcMessage = (_event: unknown, channel: string): void => {
    if (channel !== 'app:rendererReady' || !getWindow()!) return
    if (!isTrustedRendererUrl(getWindow()!.webContents.getURL(), rendererEntryUrl)) return
    // renderer 已经挂好监听：恢复 trace 投递，而不是靠定时器轮询等它就绪。
    // 监听器刻意不在首次 show 之后摘除，这样 renderer 重挂后也能重新驱动投递。
    traceOutput.rendererReady()
    showWindow()
  }
  const showWindow = (): void => {
    if (isOwnedTestApp || windowShown || !getWindow() || getWindow()!.isDestroyed()) return
    windowShown = true
    getWindow()!.show()
  }
  // ready-to-show 只代表第一帧能画，React 还没恢复 workspace/active run；此时 show 会先闪欢迎页。
  // Renderer 在关键快照稳定后主动发 app:rendererReady。保留超时兜底，避免 renderer 异常时窗口永久不可见。
  getWindow()!.webContents.on('ipc-message', onIpcMessage)
  getWindow()!.webContents.on('context-menu', (_event, params) => {
    if (!getWindow()) return
    if (shouldShowImageContextMenu(params)) {
      const { x, y } = params
      Menu.buildFromTemplate(imageContextMenuTemplate(() => {
        if (!createdWindow.isDestroyed()) createdWindow.webContents.copyImageAt(x, y)
      })).popup({ window: getWindow()! })
      return
    }
    if (shouldShowEditContextMenu(params)) {
      Menu.buildFromTemplate(editContextMenuTemplate(params)).popup({ window: getWindow()! })
    }
  })
  setTimeout(showWindow, 2500)
  if (useDevelopmentRenderer) {
    getWindow()!.loadURL(rendererEntryUrl)
  } else {
    getWindow()!.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
