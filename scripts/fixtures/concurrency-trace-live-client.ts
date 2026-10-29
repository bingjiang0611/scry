// Measurement-only client layer for the live concurrency trace fixture (R6.2).
//
// The real DesktopRemoteClient, the real device identity and the real
// desktopTlsRequest are used unchanged. The only substitution is the SSH hop:
// a direct loopback adapter dials exactly the 127.0.0.1 pair/run ports the
// current invitation advertises, so production TLS, certificate checks and the
// host's own mTLS listener stay in the measured path. Never shipped.
import {
  DesktopRemoteClient,
  parseDesktopInvitation,
  type DesktopRemoteClientTransportDeps
} from '../../src/main/remote/desktop-client'
import {
  desktopTlsRequest,
  generateDesktopDeviceIdentity,
  type DesktopSshTunnel,
  type DesktopTlsRequestOptions
} from '../../src/main/remote/desktop-transport'
import type {
  DesktopHostInvitation,
  DesktopPairingResult,
  DesktopRemoteAPI,
  DesktopRemoteContext,
  DesktopRemoteTraceRead,
  DesktopTraceCursor
} from '../../src/shared/desktop-remote'

// The generated preload re-exports this channel name; the build helper keeps the
// same literal and a focused test asserts the two stay equal.
export const LIVE_FIXTURE_CHANNEL = 'concurrency-trace-live:call'

export type LiveTlsRequest = NonNullable<DesktopRemoteClientTransportDeps['tlsRequest']>
/**
 * The dialing seam: the same wide signature as the real desktopTlsRequest, so the
 * injected default is passed through without a cast. The wrapper handed to
 * DesktopRemoteClient stays narrow (it always receives a path marker).
 */
export type LiveTlsForward = typeof desktopTlsRequest

/**
 * Reads the packaged renderer is allowed to reach. The frame never carries a
 * connection id and never submits, stops or answers: the host owns those.
 */
export type LiveReadMethod =
  | 'list'
  | 'catalog'
  | 'history'
  | 'intents'
  | 'liveRun'
  | 'runStatus'
  | 'trace'
  | 'traceDelta'
  | 'commands'
  | 'providerControls'

export const LIVE_READ_METHODS: readonly LiveReadMethod[] = [
  'list', 'catalog', 'history', 'intents', 'liveRun', 'runStatus', 'trace', 'traceDelta', 'commands', 'providerControls'
]

export type LiveReadClient = Pick<DesktopRemoteAPI, LiveReadMethod>

/** One visit's accepted identity: ids the launcher already confirmed on the host. */
export interface LivePeerTarget {
  cwd: string
  providerId: string
  agentProfileId?: string
  externalSessionId?: string
  /** Host-local run this lane reads. Trace reads are refused for any other id. */
  nativeRunId: string
}

export interface LiveTlsCounters {
  tunnelOpens: number
  pairRequests: number
  runRequests: number
  rejectedPaths: number
}

export interface LivePeerCounters {
  /** Attempted client calls, including ones the real client then rejected. */
  attempts: Record<string, number>
  tls: LiveTlsCounters
}

export interface LiveDirectTransport {
  openTunnel: NonNullable<DesktopRemoteClientTransportDeps['openTunnel']>
  tlsRequest: LiveTlsRequest
  /** Reset-on-read, so a caller can bracket one visit or one round. */
  takeCounters(): LiveTlsCounters
}

// The two path markers are private to this adapter. They are deliberately not
// filesystem paths: the direct adapter must never look like a local socket.
function tunnelPaths(pairPort: number, runPort: number): { pairPath: string; runPath: string } {
  return { pairPath: `direct-loopback:pair/${pairPort}`, runPath: `direct-loopback:run/${runPort}` }
}

function port(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`concurrency_trace_live_invalid_${name}`)
  }
  return value
}

export function createLiveDirectTransport(options: {
  pairPort: number
  runPort: number
  /** Test seam only; production wiring keeps the real desktopTlsRequest. */
  tlsRequest?: LiveTlsForward
}): LiveDirectTransport {
  const pairPort = port(options.pairPort, 'pair_port')
  const runPort = port(options.runPort, 'run_port')
  const forward: LiveTlsForward = options.tlsRequest ?? desktopTlsRequest
  const { pairPath, runPath } = tunnelPaths(pairPort, runPort)
  let counters: LiveTlsCounters = { tunnelOpens: 0, pairRequests: 0, runRequests: 0, rejectedPaths: 0 }
  const openTunnel: NonNullable<DesktopRemoteClientTransportDeps['openTunnel']> = async (requested) => {
    // The client derives these ports from the stored invitation. Any other
    // value means the wiring drifted away from the invitation this peer paired
    // with, and dialing it would reach an unrelated listener.
    if (requested.pairPort !== pairPort || requested.runPort !== runPort) {
      throw new Error('concurrency_trace_live_tunnel_port_mismatch')
    }
    counters = { ...counters, tunnelOpens: counters.tunnelOpens + 1 }
    let alive = true
    const tunnel: DesktopSshTunnel = {
      pairPath,
      runPath,
      get alive() { return alive },
      close: async () => { alive = false }
    }
    return tunnel
  }
  const tlsRequest: LiveTlsRequest = async (input) => {
    const target = input.path === pairPath ? pairPort : input.path === runPath ? runPort : undefined
    if (target === undefined) {
      counters = { ...counters, rejectedPaths: counters.rejectedPaths + 1 }
      throw new Error('concurrency_trace_live_unknown_tls_path')
    }
    counters = input.path === pairPath
      ? { ...counters, pairRequests: counters.pairRequests + 1 }
      : { ...counters, runRequests: counters.runRequests + 1 }
    // TLS material, payload, abort signal and timeout pass through untouched;
    // only the endpoint becomes loopback:port.
    const forwarded: DesktopTlsRequestOptions = {
      caPEM: input.caPEM,
      certPEM: input.certPEM,
      keyPEM: input.keyPEM,
      request: input.request,
      host: '127.0.0.1',
      port: target,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
    }
    return forward(forwarded)
  }
  return {
    openTunnel,
    tlsRequest,
    takeCounters(): LiveTlsCounters {
      const value = counters
      counters = { tunnelOpens: 0, pairRequests: 0, runRequests: 0, rejectedPaths: 0 }
      return value
    }
  }
}

// Test-only at-rest codec for the client's private state directory. It is not a
// secret store: no Keychain, no key material, and the directory is temporary.
const STATE_CODEC_PREFIX = 'concurrency-trace-live:'
const encryptState = (value: string): Buffer => Buffer.from(`${STATE_CODEC_PREFIX}${Buffer.from(value).toString('base64')}`)
const decryptState = (value: Buffer): string =>
  Buffer.from(value.toString().slice(STATE_CODEC_PREFIX.length), 'base64').toString()

export interface LivePeerReads {
  connectionId: string
  client: LiveReadClient
  /** Set only by beginVisit with the launcher's confirmed run identity. */
  readonly target: LivePeerTarget | undefined
  recordCall(method: LiveReadMethod): void
}

export class LivePeer implements LivePeerReads {
  readonly connectionId: string
  /** Read surface only: this class never pairs, connects or submits. */
  readonly client: LiveReadClient
  readonly transport: LiveDirectTransport
  private visitTarget: LivePeerTarget | undefined
  private counts: Record<string, number> = {}

  constructor(input: {
    connectionId: string
    client: LiveReadClient
    transport: LiveDirectTransport
  }) {
    this.connectionId = input.connectionId
    this.client = input.client
    this.transport = input.transport
  }

  /** Undefined until the launcher reports the run it already confirmed on the host. */
  get target(): LivePeerTarget | undefined { return this.visitTarget }

  /** One peer reads one host-local run at a time. */
  beginVisit(target: LivePeerTarget): void {
    for (const key of ['cwd', 'providerId', 'nativeRunId'] as const) {
      if (typeof target[key] !== 'string' || target[key].length === 0) throw new Error('concurrency_trace_live_invalid_target')
    }
    this.visitTarget = target
  }

  /** One attempted client call: counted after the authority checks, before the call. */
  recordCall(method: LiveReadMethod): void { this.counts[method] = (this.counts[method] ?? 0) + 1 }

  /** Authoritative per-peer attempt and raw TLS counters; reset-on-read. */
  takeCounters(): LivePeerCounters {
    const attempts = this.counts
    this.counts = {}
    return { attempts, tls: this.transport.takeCounters() }
  }
}

export interface LivePeerPairing {
  peer: LivePeer
  /** The full client the launcher uses for finishPairing/connect/dispose. */
  client: DesktopRemoteClient
  invitation: DesktopHostInvitation & { anchorSHA256: string }
  /** Real pair.prove answer. Approval is the launcher's host-side action. */
  pairing: DesktopPairingResult
}

/**
 * Pairs one peer against a live host invitation. The returned pairing is the
 * host's actual answer (normally `pending`); the launcher approves it with the
 * host's typed remoteConfirmPairing and then calls finishPairing/connect.
 */
export async function pairLivePeer(options: {
  directory: string
  invitation: string
  label: string
  /** Same wide seam as createLiveDirectTransport; the client wrapper stays narrow. */
  tlsRequest?: LiveTlsForward
}): Promise<LivePeerPairing> {
  const invitation = parseDesktopInvitation(options.invitation)
  const transport = createLiveDirectTransport({
    pairPort: invitation.pairPort,
    runPort: invitation.runPort,
    ...(options.tlsRequest ? { tlsRequest: options.tlsRequest } : {})
  })
  const client = new DesktopRemoteClient(
    { directory: options.directory, encrypt: encryptState, decrypt: decryptState },
    { generateIdentity: generateDesktopDeviceIdentity, openTunnel: transport.openTunnel, tlsRequest: transport.tlsRequest }
  )
  const pairing = await client.pair({
    label: options.label,
    // Routing metadata only: the direct adapter dials loopback, never this SSH target.
    ssh: { hostname: '127.0.0.1', username: 'concurrency-trace', port: 22 },
    invitation: options.invitation
  })
  const peer = new LivePeer({ connectionId: pairing.connection.id, client, transport })
  // No target yet: the launcher sets it with beginVisit once it has confirmed the
  // host-local run. Reads before that are refused instead of using a guessed id.
  return { peer, client, invitation, pairing }
}

export interface LiveFixtureCall {
  peerId: number
  frameUrl: string | null
  mainFrame: boolean
  method: string
  args: readonly unknown[]
}

export interface LiveFixtureHost {
  /** Exact URL of the fixture document the only trusted frame loads. */
  trustedUrl: string
  peers: ReadonlyMap<number, LivePeerReads>
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function reject(reason: string): never { throw new Error(`concurrency_trace_live_${reason}`) }

function requireTarget(peer: LivePeerReads): LivePeerTarget {
  if (!peer.target) reject('no_target')
  return peer.target
}

function assertContext(peer: LivePeerReads, value: unknown, withSession: boolean): DesktopRemoteContext {
  if (!isRecord(value)) reject('invalid_context')
  const target = requireTarget(peer)
  if (value.cwd !== target.cwd || value.providerId !== target.providerId) reject('unauthorized_target')
  if ((value.agentProfileId ?? '') !== (target.agentProfileId ?? '')) reject('unauthorized_target')
  const sessionId = value.externalSessionId
  if (sessionId !== undefined && sessionId !== target.externalSessionId) reject('unauthorized_target')
  if (withSession && sessionId !== target.externalSessionId) reject('unauthorized_target')
  return {
    cwd: value.cwd,
    providerId: value.providerId,
    ...(value.agentProfileId === undefined ? {} : { agentProfileId: value.agentProfileId as string }),
    ...(sessionId === undefined ? {} : { externalSessionId: sessionId as string })
  }
}

/** Only the launcher-confirmed host-local run is readable; no dynamic widening. */
function assertRun(peer: LivePeerReads, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) reject('invalid_run')
  if (value !== requireTarget(peer).nativeRunId) reject('unauthorized_run')
  return value
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) reject(`invalid_${name}`)
  return value
}

function optionalCursor(value: unknown): DesktopTraceCursor | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.revision !== 'string' || typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0) {
    reject('invalid_cursor')
  }
  return { revision: value.revision as string, count: value.count as number }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') reject(`invalid_${name}`)
  return value
}

function expectArity(args: readonly unknown[], min: number, max: number, method: string): void {
  if (args.length < min || args.length > max) reject(`invalid_arguments:${method}`)
}

/**
 * The live lane follows one host-local run through the delta path: every answer
 * must carry the delta cursor and name that exact run. A host that cannot serve
 * deltas (snapshot without cursor), reports no run, or names another run is
 * refused instead of being read as a successful round.
 */
function assertTraceRead(read: DesktopRemoteTraceRead, runId: string): void {
  if (read.cursor === undefined) reject('unexpected_trace_run')
  if (read.run === null) reject('unexpected_trace_run')
  if (read.run.runId !== runId) reject('unexpected_trace_run')
}

/**
 * Validates one fixture IPC call and forwards it to the peer's real client.
 * Frame identity, method and target are all rejected before the client method
 * runs; the connection id always comes from main's peer map.
 */
export async function dispatchLiveFixtureCall(host: LiveFixtureHost, call: LiveFixtureCall): Promise<unknown> {
  if (!call.mainFrame) reject('untrusted_frame')
  if (call.frameUrl === null || call.frameUrl !== host.trustedUrl) reject('untrusted_frame_url')
  const peer = host.peers.get(call.peerId) ?? reject('unknown_peer')
  if (!(LIVE_READ_METHODS as readonly string[]).includes(call.method)) reject(`unknown_method:${call.method}`)
  const method = call.method as LiveReadMethod
  const args = call.args
  switch (method) {
    case 'list':
      expectArity(args, 0, 0, method)
      peer.recordCall(method)
      return peer.client.list()
    case 'catalog':
      expectArity(args, 0, 0, method)
      peer.recordCall(method)
      return peer.client.catalog(peer.connectionId)
    case 'intents': {
      expectArity(args, 0, 0, method)
      peer.recordCall(method)
      // Receipts are returned as-is: this lane never derives read authority from them.
      return peer.client.intents(peer.connectionId)
    }
    case 'history': {
      expectArity(args, 1, 3, method)
      const context = assertContext(peer, args[0], true)
      const before = optionalNumber(args[1], 'before')
      const snapshot = optionalString(args[2], 'snapshot')
      peer.recordCall(method)
      return peer.client.history(peer.connectionId, context, before, snapshot)
    }
    case 'liveRun': {
      expectArity(args, 1, 1, method)
      const context = assertContext(peer, args[0], true)
      peer.recordCall(method)
      const live = await peer.client.liveRun(peer.connectionId, context)
      // This lane reads a run the host itself started: any other origin, or a
      // different trace identity, means the visit is not measuring that run.
      if (live !== null && (live.origin !== 'mac' || live.scryRunId !== requireTarget(peer).nativeRunId)) {
        reject('unexpected_live_run')
      }
      return live
    }
    case 'runStatus': {
      expectArity(args, 1, 1, method)
      const runId = assertRun(peer, args[0])
      peer.recordCall(method)
      return peer.client.runStatus(peer.connectionId, runId)
    }
    case 'trace': {
      expectArity(args, 2, 3, method)
      const context = assertContext(peer, args[0], true)
      const runId = assertRun(peer, args[1])
      const known = optionalNumber(args[2], 'known_attachment_count')
      peer.recordCall(method)
      return peer.client.trace(peer.connectionId, context, runId, known)
    }
    case 'traceDelta': {
      expectArity(args, 2, 4, method)
      const context = assertContext(peer, args[0], true)
      const runId = assertRun(peer, args[1])
      const after = optionalCursor(args[2])
      const known = optionalNumber(args[3], 'known_attachment_count')
      peer.recordCall(method)
      const read = await peer.client.traceDelta(peer.connectionId, context, runId, after, known)
      assertTraceRead(read, runId)
      return read
    }
    case 'commands': {
      expectArity(args, 1, 1, method)
      const context = assertContext(peer, args[0], false)
      peer.recordCall(method)
      return peer.client.commands(peer.connectionId, context)
    }
    case 'providerControls': {
      expectArity(args, 1, 1, method)
      const context = assertContext(peer, args[0], false)
      peer.recordCall(method)
      return peer.client.providerControls(peer.connectionId, context)
    }
    default:
      return reject(`unknown_method:${String(method)}`)
  }
}

export interface LiveFixtureIpcEvent {
  sender: { id: number; mainFrame: unknown }
  senderFrame: { url: string } | null
}

/** Structural view of Electron's ipcMain, so this module stays Electron-free. */
export interface LiveFixtureIpcMain {
  handle(channel: string, listener: (event: LiveFixtureIpcEvent, method: unknown, args: unknown) => Promise<unknown>): void
}

/**
 * Registers the fixture channel. The launcher passes the real ipcMain; peer
 * identity comes from the sending WebContents, never from the payload.
 */
export function registerLiveFixtureChannel(ipcMain: LiveFixtureIpcMain, host: LiveFixtureHost): void {
  ipcMain.handle(LIVE_FIXTURE_CHANNEL, (event, method, args) => {
    const frame = event.senderFrame
    return dispatchLiveFixtureCall(host, {
      peerId: event.sender.id,
      frameUrl: frame && typeof frame.url === 'string' ? frame.url : null,
      mainFrame: frame !== null && frame === event.sender.mainFrame,
      method: typeof method === 'string' ? method : '',
      args: Array.isArray(args) ? args : []
    })
  })
}
