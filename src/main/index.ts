import './daemon-mode-default-entry'
import { app, ipcMain, dialog, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mainEventId } from './bootstrap/main-event-id'
import { registerDesktopClientIpc } from './remote/desktop-client-ipc'
import { createRemoteAttentionTracker } from './remote/remote-attention'
import { createRemoteConnections } from './bootstrap/remote-connections'
import { registerTrustedIpcHandler } from './ipc-trust'
import { initializeAppEnvironment, registerAppLifecycle } from './bootstrap/app-lifecycle'
import { registerAgentRuntimeHandlers } from './bootstrap/agent-runtime-ipc'
import { appDaemonModeDeps } from './bootstrap/daemon-run-mode'
import { createLazyDaemonRunSurface } from './bootstrap/daemon-run-lazy'
import { createDaemonLoginStartBridge, registerBackgroundServiceHandlers } from './bootstrap/background-service'
import { createTraceRuntime } from './bootstrap/trace-runtime'
import { createWindow as createBootstrapWindow } from './bootstrap/window'
import { createRendererRestartLog } from './bootstrap/renderer-restart'
import { registerWorkspaceHandlers } from './bootstrap/workspace'
import { registerAppAgentHandlers } from './bootstrap/app-agent'
import { registerConversationAttention } from './bootstrap/conversation-attention'
import { installDaemonConversationSend } from './bootstrap/conversation-daemon-send'
import { registerProjectHandlers } from './bootstrap/project-handlers'
import { installProviderContextWindowCwd } from './bootstrap/project-daemon'
import { installMcpDaemonWindow } from './bootstrap/mcp-daemon'
import { installSessionLifecycleDialogs } from './bootstrap/session-lifecycle-daemon'
import { confirmWithDialog, notifyWithDialog } from './bootstrap/session-dialogs'
import { installDaemonSessionSelection } from './bootstrap/history-daemon'
import { applySessionSelection } from './bootstrap/session-selection'
import { daemonKnownProjectDirectory } from './bootstrap/known-project-daemon'
import { registerDaemonOwnedChannels } from './bootstrap/daemon-owned-channels'
import { activeRunSessionKey, createDockBadge, providerContextKey, providerSessionKey } from './bootstrap/attention-state'
import { readConversationLedger } from './conversation-ledger-read'
import { HomeFileAccess } from './home-file-access'
import { homedir } from 'node:os'

// The App main process does window, UI and OS work and talks to the background service
// (src/daemon), which owns runs, Providers, terminals, SQLite, the ledgers, source
// control and the recorder. Every channel the daemon answers is registered at the end
// (registerDaemonOwnedChannels) and forwarded by the gate in ipc-trust.ts; the modules
// below register only this window's own channels and the window parts of split ones.

const __dirname = dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null
const { rendererEntryUrl, useDevelopmentRenderer, isOwnedTestApp, primaryInstance } =
  initializeAppEnvironment(__dirname, () => win)
let isShuttingDown = false
let currentCwd: string | undefined

const dockBadge = createDockBadge({
  setBadgeCount: (count) => app.setBadgeCount(count),
  publishUnreadSessions: (snapshot) => { win?.webContents.send('agent:unreadSessions', snapshot) }
})

function rendererCanReceive(): boolean {
  return Boolean(win && !win.isDestroyed() && !win.webContents.isDestroyed())
}
function setCurrentCwd(dir: string | undefined): void {
  currentCwd = dir
}
const getCurrentCwd = (): string | undefined => currentCwd
const getWindow = (): BrowserWindow | null => win

// The window's view of runs: the trace streams it delivers and the run registry the
// router reads (daemon runs attach to the router; this registry holds none of them).
const { runs, runStopLifecycle, traceOutput, runTraces } = createTraceRuntime({
  renderer: { send: (channel, payload) => { win?.webContents.send(channel, payload) }, isFocused: () => Boolean(win?.isFocused()) },
  rendererCanReceive, activeRunSessionKey, dockBadge, mainEventId
})

const rendererRestart = createRendererRestartLog()
const createWindow = (): void => createBootstrapWindow({
  __dirname,
  rendererEntryUrl,
  useDevelopmentRenderer,
  isOwnedTestApp,
  getWindow,
  setWindow: (next) => { win = next },
  traceOutput,
  runTraces,
  dockBadge,
  resetSessionAttention: () => resetConversationAttention(),
  isShuttingDown: () => isShuttingDown,
  rendererAutoReloadCooldownMs: 60_000,
  rendererRestart
})

const registered = new Set<string>()
function handleTrusted<TArgs extends unknown[], TResult>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult
): void {
  registered.add(channel)
  registerTrustedIpcHandler(ipcMain, channel, getWindow, rendererEntryUrl, listener)
}

handleTrusted('app:rendererRestart', () => rendererRestart.take())

async function openLocalPath(path: string): Promise<void> {
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}

registerAppAgentHandlers({ handleTrusted, getWindow, dialog, setCurrentCwd, getCurrentCwd })
registerWorkspaceHandlers({
  handleTrusted, getCurrentCwd, setCurrentCwd, homeFileAccess: new HomeFileAccess(homedir()), openLocalPath,
  shell, dialog, getWindow, isShuttingDown: () => isShuttingDown, rendererCanReceive, dockBadge
})
registerProjectHandlers({ handleTrusted })

// Provider context and MCP run in the daemon; a context without a cwd takes this window's
// selection, and an MCP re-auth's OAuth page opens here.
installProviderContextWindowCwd(getCurrentCwd)
installMcpDaemonWindow({ openExternal: (url) => shell.openExternal(url) })

// Session delete/rename/pin/archive run in the daemon; the dialogs stay in this window.
installSessionLifecycleDialogs({
  confirm: confirmWithDialog(getWindow), notifyFailure: notifyWithDialog(getWindow), confirmSingle: !isOwnedTestApp,
  windowCwd: getCurrentCwd
})

// The daemon loads every history page and reports which session the window now shows.
const sessionByContext = new Map<string, string>()
const sessionAliasesByContext = new Map<string, Map<string, string>>()
const sessionRevisionByContext = new Map<string, number>()
installDaemonSessionSelection((selection) => applySessionSelection({
  dockBadge, isWindowFocused: () => Boolean(win?.isFocused()), setCurrentCwd, providerContextKey, providerSessionKey,
  bumpSessionRevision: (key) => { sessionRevisionByContext.set(key, (sessionRevisionByContext.get(key) ?? 0) + 1) },
  sessionAliasesByContext, sessionByContext
}, selection))

// The daemon's conversation handlers announce their writes through its event feed; a
// send also needs its run followed here.
installDaemonConversationSend((event) => { win?.webContents.send('agent:dataUpdated', event) })

// The managed conversation on screen is dock-badge view state, which this window renders.
// Its ledger file is read only; whether its directory is known is the daemon's answer.
const conversationLedgers = join(app.getPath('userData'), 'conversations')
// A view the daemon could not confirm is applied again once it is ready (daemonRun below).
const daemonReadyListeners: Array<() => void> = []
const resetConversationAttention = registerConversationAttention({
  handleTrusted, readConversation: (id) => readConversationLedger(conversationLedgers, id), resolveKnownProjectDirectory: daemonKnownProjectDirectory,
  getWindow, clearLegacyFocus: () => { runs.focus(null) }, dockBadge, onDaemonReady: (listener) => { daemonReadyListeners.push(listener) }
})

// The App's client to other hosts; the hosts it saves are the App's own state.
const remoteAttention = createRemoteAttentionTracker((keys) => dockBadge.setRemote(keys))
const { requireDesktopRemoteClient, getDesktopRemoteClient } = createRemoteConnections({ remoteAttention })
registerDesktopClientIpc(handleTrusted, requireDesktopRemoteClient)

const loginStartBridge = createDaemonLoginStartBridge()
const daemonRun = createLazyDaemonRunSurface(appDaemonModeDeps({
  send: (channel, payload) => { win?.webContents.send(channel, payload) }, currentCwd: getCurrentCwd,
  getWindow, dockBadge, isWindowFocused: () => Boolean(win?.isFocused()), rendererCanReceive, runTraces,
  desktopRemoteClient: () => requireDesktopRemoteClient(), ...loginStartBridge.daemonModeOptions
}))
daemonRun.onOutcome((result) => { if (result.status === 'ready') for (const listener of daemonReadyListeners) listener() })
registerAgentRuntimeHandlers({ handleTrusted, runs, dockBadge, activeRunSessionKey, getWindow, getCurrentCwd, runTraces, daemon: daemonRun })
registerBackgroundServiceHandlers({ handleTrusted, daemon: daemonRun, getWindow, ...loginStartBridge.handlerOptions })

// Last: every channel the daemon answers that the App did not register itself.
registerDaemonOwnedChannels(handleTrusted, registered)

registerAppLifecycle({
  primaryInstance, useDevelopmentRenderer, dockBadge, createWindow, traceOutput, runs,
  requireDesktopRemoteClient, getDesktopRemoteClient, runStopLifecycle, runTraces,
  beginShutdown: () => { isShuttingDown = true }
})
