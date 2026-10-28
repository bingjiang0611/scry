import { join } from 'node:path'
import { BrowserWindow, Menu, dialog, shell } from 'electron'
import { editContextMenuTemplate, imageContextMenuTemplate, shouldShowEditContextMenu, shouldShowImageContextMenu } from './edit-context-menu'
import { configureRendererPermissions, isAllowedRendererRequest, isSafeExternalUrl, isTrustedRendererUrl, rendererContentSecurityPolicy } from './renderer-security'
import { windowBackgroundColor, windowTitleBarOptions } from './window-chrome'
import type { DockBadgeState } from './dock-badge'
import type { TerminalOutputBridge } from './terminal-output'
import type { TraceOutputBridge } from './trace-output'

export interface MainWindowRuntimeDeps {
  dirname: string
  rendererEntryUrl: string
  useDevelopmentRenderer: boolean
  isOwnedTestApp: boolean
  isShuttingDown: () => boolean
  getWindow: () => BrowserWindow | null
  setWindow: (window: BrowserWindow | null) => void
  dockBadge: DockBadgeState
  terminalOutput: TerminalOutputBridge
  traceOutput: TraceOutputBridge
}

export function createMainWindow(deps: MainWindowRuntimeDeps): void {
  const createdWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 860,
    title: 'Scry',
    show: false,
    backgroundColor: windowBackgroundColor('dark'),
    ...windowTitleBarOptions(),
    webPreferences: {
      preload: join(deps.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !deps.isOwnedTestApp
    }
  })
  deps.setWindow(createdWindow)
  createdWindow.on('focus', () => deps.dockBadge.focusWindow())
  createdWindow.on('closed', () => {
    deps.terminalOutput.detachRenderer()
    deps.traceOutput.reset()
    if (deps.getWindow() === createdWindow) deps.setWindow(null)
  })
  createdWindow.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    deps.terminalOutput.detachRenderer()
    deps.traceOutput.reset()
  })
  let lastRendererAutoReloadAt = Number.NEGATIVE_INFINITY
  createdWindow.webContents.on('render-process-gone', (_event, details) => {
    deps.terminalOutput.detachRenderer()
    deps.traceOutput.reset()
    console.error(`[scry] renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`)
    if (details.reason === 'clean-exit' || deps.isShuttingDown() || createdWindow.isDestroyed()) return
    const now = Date.now()
    if (now - lastRendererAutoReloadAt >= 60_000) {
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
  createdWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[scry] preload failed: ${preloadPath}`, error)
  })
  const rendererSession = createdWindow.webContents.session
  configureRendererPermissions(rendererSession, deps.rendererEntryUrl)
  rendererSession.webRequest.onBeforeRequest((details, callback) => {
    callback(isAllowedRendererRequest(details.url, deps.rendererEntryUrl) ? {} : { cancel: true })
  })
  rendererSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [rendererContentSecurityPolicy(deps.rendererEntryUrl)] } })
  })
  createdWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, deps.rendererEntryUrl)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
  createdWindow.webContents.on('will-redirect', (event, url) => {
    if (isTrustedRendererUrl(url, deps.rendererEntryUrl)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
  createdWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  createdWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  let windowShown = false
  const showWindow = (): void => {
    if (deps.isOwnedTestApp || windowShown || createdWindow.isDestroyed()) return
    windowShown = true
    createdWindow.show()
  }
  const onIpcMessage = (_event: unknown, channel: string): void => {
    if (channel !== 'app:rendererReady' || deps.getWindow() !== createdWindow) return
    if (!isTrustedRendererUrl(createdWindow.webContents.getURL(), deps.rendererEntryUrl)) return
    deps.traceOutput.rendererReady()
    showWindow()
  }
  createdWindow.webContents.on('ipc-message', onIpcMessage)
  createdWindow.webContents.on('context-menu', (_event, params) => {
    if (deps.getWindow() !== createdWindow) return
    if (shouldShowImageContextMenu(params)) {
      const { x, y } = params
      Menu.buildFromTemplate(imageContextMenuTemplate(() => {
        if (!createdWindow.isDestroyed()) createdWindow.webContents.copyImageAt(x, y)
      })).popup({ window: createdWindow })
      return
    }
    if (shouldShowEditContextMenu(params)) Menu.buildFromTemplate(editContextMenuTemplate(params)).popup({ window: createdWindow })
  })
  setTimeout(showWindow, 2500)
  if (deps.useDevelopmentRenderer) createdWindow.loadURL(deps.rendererEntryUrl)
  else createdWindow.loadFile(join(deps.dirname, '../renderer/index.html'))
}
