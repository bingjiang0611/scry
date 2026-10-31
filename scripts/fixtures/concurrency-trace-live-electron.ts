// Private client Electron main for the live concurrency trace lane (R6.3).
//
// One process owns every remote peer: each peer gets its own state directory, its own
// real DesktopRemoteClient (loopback TLS to the loopback host), and its own hidden
// BrowserWindow that loads the built fixture renderer (production RemoteChat). The
// launcher drives it over the inherited Node IPC channel with the fixed command enum
// in concurrency-trace-live-commands.ts, nothing else.
//
// This process is not product code: it is spawned by the launcher from a temporary
// build, exposes the same fixed `concurrency-snapshot` reply the C1 bootstrap uses,
// and never accepts JavaScript, commands or arbitrary paths from a renderer.
import { BrowserWindow, app, ipcMain } from 'electron'
import { pathToFileURL } from 'node:url'
import {
  CLIENT_FAULT_TYPE,
  CLIENT_REPLY_TYPE,
  SNAPSHOT_MESSAGE_TYPE,
  driverExpression,
  parseClientRequest,
  parseDriverCall,
  parsePairPayload,
  parsePeerPayload,
  parseVisitTarget,
  type ClientReply,
  type ClientRequest
} from './concurrency-trace-live-commands'
import {
  pairLivePeer,
  registerLiveFixtureChannel,
  type LiveFixtureHost,
  type LivePeer,
  type LivePeerPairing
} from './concurrency-trace-live-client'

interface ClientConfig {
  indexPath: string
  preloadPath: string
  userDataPath: string
  stateRoot: string
  hiddenWindowsPath: string
  windowOptionsJson: string
}

function required(name: string): string {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`concurrency_trace_live_client_missing_configuration: ${name} is required`)
  }
  return value
}

/**
 * Read once, as strings. Closures below then use `config`, so narrowing does not depend
 * on `process.env` still being the same at call time.
 */
const config: ClientConfig = {
  indexPath: required('LIVE_INDEX'),
  preloadPath: required('LIVE_PRELOAD'),
  userDataPath: required('LIVE_USER_DATA'),
  stateRoot: required('LIVE_STATE'),
  hiddenWindowsPath: required('LIVE_HIDDEN_WINDOWS'),
  windowOptionsJson: required('LIVE_WINDOW_OPTIONS')
}

// Electron's default userData would be the developer's real App directory. The launcher
// passes a temporary directory and this process uses it before anything else loads.
app.setPath('userData', config.userDataPath)

interface WindowOptionsShape {
  title?: string
  show?: boolean
  width?: number
  height?: number
  webPreferences?: { sandbox?: boolean; contextIsolation?: boolean; nodeIntegration?: boolean; backgroundThrottling?: boolean }
}

const requestedWindow = JSON.parse(config.windowOptionsJson) as WindowOptionsShape

/**
 * The window options come from the build helper, not from this process, so a launcher
 * cannot quietly relax them: a visible window or a loosened sandbox is refused here.
 */
function windowOptions(): WindowOptionsShape & { webPreferences: NonNullable<WindowOptionsShape['webPreferences']> & { preload: string } } {
  const web = requestedWindow.webPreferences ?? {}
  if (requestedWindow.show !== false) throw new Error('concurrency_trace_live_window_must_be_hidden')
  if (web.sandbox !== true || web.contextIsolation !== true || web.nodeIntegration !== false) {
    throw new Error('concurrency_trace_live_window_security_relaxed')
  }
  return { ...requestedWindow, webPreferences: { ...web, preload: config.preloadPath } }
}

let hiddenWindowsInstalled: Promise<void> | null = null

/** Installed before the first window exists; the module exits the process on a violation. */
function installHiddenWindows(): Promise<void> {
  hiddenWindowsInstalled ??= (async () => {
    const loaded = await import(pathToFileURL(config.hiddenWindowsPath).href) as { default?: unknown }
    if (typeof loaded.default !== 'function') throw new Error('concurrency_trace_live_hidden_window_module_invalid')
    ;(loaded.default as (target: typeof app) => void)(app)
  })()
  return hiddenWindowsInstalled
}

interface PeerRecord {
  peerId: number
  label: string
  directory: string
  peer: LivePeer
  client: LivePeerPairing['client']
  connectionId: string
  window?: BrowserWindow
  webContentsId?: number
  /** The renderer process this peer's hidden window owns, for CPU attribution. */
  rendererPid?: number
  abandoned: boolean
}

const peers = new Map<number, PeerRecord>()
// The same map host.peers exposes as read-only: window registration mutates it directly,
// so there is no cast and no second source of truth.
const peersByWebContents = new Map<number, LivePeer>()
const host: LiveFixtureHost = { trustedUrl: pathToFileURL(config.indexPath).toString(), peers: peersByWebContents }
registerLiveFixtureChannel(ipcMain, host)

// The hidden-window enforcer must be installed before any window exists. It turns a
// creation-with-show, show, focus or restore into an immediate exit instead of a
// window appearing on the user's desktop.
const hiddenWindowsReady = installHiddenWindows()

function snapshot(): Record<string, unknown> {
  return {
    // Own pid of this client main: a renderer-filtered delta must not present these `cpu`
    // counters as renderer cost (samples.mjs checks the pid against the filter).
    pid: process.pid,
    monotonicMs: Number(process.hrtime.bigint() / 1000000n),
    cpu: process.cpuUsage(),
    memory: process.memoryUsage(),
    metrics: app.getAppMetrics().map((entry) => ({
      pid: entry.pid,
      type: entry.type,
      creationTime: Number.isFinite(entry.creationTime) ? entry.creationTime : null,
      cumulativeCpuSeconds: entry.cpu && Number.isFinite(entry.cpu.cumulativeCPUUsage) ? entry.cpu.cumulativeCPUUsage : null,
      workingSetKb: entry.memory ? entry.memory.workingSetSize : null
    }))
  }
}

// Only objects cross the IPC boundary here; the type matches what process.send accepts.
function send(message: object): void {
  if (typeof process.send === 'function') process.send(message)
}

function reply(value: ClientReply): void { send(value) }

function fault(phase: string, error: unknown): void {
  send({ type: CLIENT_FAULT_TYPE, phase, error: error instanceof Error ? error.message : String(error) })
}

function peerOf(peerId: number): PeerRecord {
  const record = peers.get(peerId)
  if (!record) throw new Error(`concurrency_trace_live_unknown_peer:${peerId}`)
  return record
}

function windowOf(record: PeerRecord): BrowserWindow {
  if (!record.window || record.window.isDestroyed()) throw new Error(`concurrency_trace_live_window_unavailable:${record.peerId}`)
  return record.window
}

async function createWindow(record: PeerRecord): Promise<{ webContentsId: number; rendererPid: number; driverInstalled: boolean; url: string }> {
  if (record.window && !record.window.isDestroyed()) throw new Error(`concurrency_trace_live_window_exists:${record.peerId}`)
  const window = new BrowserWindow(windowOptions())
  record.window = window
  const webContentsId = window.webContents.id
  record.webContentsId = webContentsId
  // Main maps webContents → peer; the renderer never carries a connection id in the frame.
  peersByWebContents.set(webContentsId, record.peer)
  window.on('closed', () => {
    peersByWebContents.delete(webContentsId)
    if (record.window === window) record.window = undefined
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    fault(`renderer-gone:${record.peerId}`, details)
    app.exit(1)
  })
  await window.loadFile(config.indexPath)
  // getOSProcessId() is the OS pid behind this renderer, so a CPU delta can be taken for
  // exactly this window instead of every renderer in the process tree.
  record.rendererPid = window.webContents.getOSProcessId()
  const driverInstalled = await window.webContents.executeJavaScript(
    `typeof window.__scryTraceLive === 'object' && typeof window.__scryTraceLive.beginVisit === 'function'`
  ) === true
  return { webContentsId, rendererPid: record.rendererPid, driverInstalled, url: window.webContents.getURL() }
}

async function runCommand(request: ClientRequest): Promise<unknown> {
  switch (request.command) {
    case 'status':
      return {
        ready: app.isReady(),
        trustedUrl: host.trustedUrl,
        userData: app.getPath('userData'),
        stateRoot: config.stateRoot,
        peers: [...peers.values()].map((record) => ({
          peerId: record.peerId,
          connectionId: record.connectionId,
          directory: record.directory,
          abandoned: record.abandoned,
          window: record.window ? { webContentsId: record.webContentsId, rendererPid: record.rendererPid ?? null, url: record.window.webContents.getURL() } : null
        }))
      }
    case 'pair': {
      const input = parsePairPayload(request.payload)
      if (peers.has(input.peerId)) throw new Error(`concurrency_trace_live_peer_exists:${input.peerId}`)
      if (!input.directory.startsWith(config.stateRoot)) throw new Error('concurrency_trace_live_directory_outside_state_root')
      const pairing = await pairLivePeer({ directory: input.directory, invitation: input.invitation, label: input.label })
      const record: PeerRecord = {
        peerId: input.peerId,
        label: input.label,
        directory: input.directory,
        peer: pairing.peer,
        client: pairing.client,
        connectionId: pairing.pairing.connection.id,
        abandoned: false
      }
      peers.set(input.peerId, record)
      return {
        peerId: input.peerId,
        connectionId: record.connectionId,
        state: pairing.pairing.state,
        publicKeySHA256: pairing.pairing.publicKeySHA256,
        pairingId: pairing.invitation.pairingId,
        hostId: pairing.invitation.hostId
      }
    }
    case 'finish': {
      const { peerId } = parsePeerPayload(request.payload)
      const record = peerOf(peerId)
      const finished = await record.client.finishPairing(record.connectionId)
      // A pending pairing is never a connected peer: finishPairing must have been granted.
      if (finished.state !== 'paired') throw new Error(`concurrency_trace_live_pairing_not_granted:${finished.state}`)
      await record.client.connect(record.connectionId)
      return { peerId, connectionId: record.connectionId, state: finished.state }
    }
    case 'window': {
      const { peerId } = parsePeerPayload(request.payload)
      return await createWindow(peerOf(peerId))
    }
    case 'driver': {
      const call = parseDriverCall(request.payload)
      const record = peerOf(call.peerId)
      if (call.injectFailure) throw new Error('concurrency_trace_live_injected_fail_after_round')
      const window = windowOf(record)
      if (call.method === 'beginVisit') {
        const target = parseVisitTarget(call.args[0])
        if (target.connectionId !== record.connectionId) throw new Error('concurrency_trace_live_connection_mismatch')
        // Main holds the authoritative run identity and the host session for this visit
        // before the renderer reads anything.
        record.peer.beginVisit({
          cwd: target.cwd,
          providerId: target.providerId,
          nativeRunId: target.nativeRunId,
          externalSessionId: target.session.externalSessionId,
          ...(target.agentProfileId ? { agentProfileId: target.agentProfileId } : {})
        })
      }
      return await window.webContents.executeJavaScript(driverExpression(call.method, call.args))
    }
    case 'counters': {
      const { peerId } = parsePeerPayload(request.payload)
      return peerOf(peerId).peer.takeCounters()
    }
    case 'abandon': {
      // A failed visit is closed, not ended: destroying the window frees the renderer
      // without pretending the seven rounds completed.
      const { peerId } = parsePeerPayload(request.payload)
      const record = peerOf(peerId)
      record.abandoned = true
      const window = record.window
      if (window && !window.isDestroyed()) window.destroy()
      return { peerId, closed: true, rendererPid: record.rendererPid ?? null }
    }
    case 'close': {
      // Peer cleanup only. Quitting here would exit before the launcher's owner can capture
      // this process tree, so the launcher stops it with SIGTERM and the handler below turns
      // that into the normal quit.
      const closed: number[] = []
      for (const record of peers.values()) {
        if (record.window && !record.window.isDestroyed()) { closed.push(record.peerId); record.window.destroy() }
      }
      return { closedPeers: closed }
    }
    default:
      throw new Error('concurrency_trace_live_unexpected_command')
  }
}

process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && (message as { type?: unknown }).type === SNAPSHOT_MESSAGE_TYPE) {
    const requestId = (message as { requestId?: unknown }).requestId
    if (typeof requestId !== 'string') return
    send({ type: SNAPSHOT_MESSAGE_TYPE, requestId, snapshot: snapshot() })
    return
  }
  let request: ClientRequest
  try {
    request = parseClientRequest(message)
  } catch (error) {
    const requestId = message && typeof message === 'object' ? (message as { requestId?: unknown }).requestId : undefined
    reply({ type: CLIENT_REPLY_TYPE, requestId: typeof requestId === 'string' ? requestId : '', ok: false, phase: 'request', error: error instanceof Error ? error.message : String(error) })
    return
  }
  // No command may create a window before the hidden-window enforcer is in place.
  void hiddenWindowsReady.then(() => runCommand(request)).then(
    (value) => reply({ type: CLIENT_REPLY_TYPE, requestId: request.requestId, ok: true, value }),
    (error: unknown) => reply({ type: CLIENT_REPLY_TYPE, requestId: request.requestId, ok: false, phase: request.command, error: error instanceof Error ? error.message : String(error) })
  )
})

// Electron quits when the last window closes. That default would end this process as soon as
// 'abandon' or 'close' destroyed the last peer window, which is before the launcher's owner
// captured the tree, so ownership degraded to "descendants unknown" even though nothing leaked.
// Staying alive keeps `status` answerable while the windows are gone; the only exit is the
// owner's SIGTERM below.
app.on('window-all-closed', () => {
  // Deliberately empty: the launcher's owner decides when this process exits.
})

// SIGTERM is a normal shutdown for this fixture: the launcher's owner captured the tree
// first, so quitting here yields a real close instead of a signal-only exit.
process.on('SIGTERM', () => { app.quit() })
process.on('uncaughtException', (error) => { fault('uncaughtException', error); app.exit(1) })
process.on('unhandledRejection', (error) => { fault('unhandledRejection', error); app.exit(1) })

void app.whenReady().then(() => { app.dock?.hide() })
