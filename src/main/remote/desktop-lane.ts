import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { remoteOperationCounters, remoteRequestTrace } from './remote-request-timing'

// Persistent inner-mTLS lanes for the desktop run channel.
//
// Every one-shot exchange pays a full TLS 1.3 handshake (and, over SSH, a fresh
// unix-socket connect) before the request can even be written. A lane keeps one
// authenticated tunnel open and sends further requests on it, one outstanding
// request at a time - the host never pipelines, and it re-authorizes every
// request against the verified peer certificate.
//
// Separate lanes keep slow work from blocking interactive work:
//   control: submit, answers, stop, catalogs, run state (short)
//   watch:   one run's long-poll
//   status:  the live-run long-poll
//   bulk:    history pages, trace pages, attachments (large)
//
// Retry rules are explicit, not error-string guesses:
//   - Opening a channel may retry: no request byte has been sent yet, so a stale
//     tunnel or a closed host leg cannot have run anything.
//   - A request whose bytes never reached the socket is re-sent on a new channel,
//     at most twice.
//   - A request whose bytes were written is re-sent once only when the caller
//     marked it replayable (reads). A write surfaces the error so the caller keeps
//     the outcome unknown and reconciles by intent id; it is never replayed.
//   - Only a reply starting with `{"keepAlive":true,` proves the host keeps the
//     tunnel open. Anything else is a protocol mismatch, never a silent fallback
//     to one-shot requests.
export type DesktopLaneName = 'control' | 'status' | 'watch' | 'bulk'

export interface DesktopLaneEndpoint {
  path?: string
  host?: string
  port?: number
  caPEM: string
  certPEM: string
  keyPEM: string
}

// The minimal duplex the lane needs. Tests supply a fake channel instead of TLS;
// production uses connectDesktopLane.
export interface DesktopLaneChannel {
  // Resolves once the frame left this process; rejects when it did not.
  send(frame: string): Promise<void>
  // One reply line, bounded by the lane's response timeout.
  receive(): Promise<string>
  destroy(): void
  // The listener receives the reason the channel closed, so a socket error or an
  // oversized reply keeps its own diagnostic. Returns the remover, so a settled
  // request leaves no listener behind.
  onClose(listener: (reason: Error) => void): () => void
}

export type DesktopLaneConnector = (endpoint: DesktopLaneEndpoint) => Promise<DesktopLaneChannel>

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const KEEP_ALIVE_PREFIX = '{"keepAlive":true'
// Close before the host's 30 s idle timeout, so a request is never written into a
// tunnel the host is about to drop.
const IDLE_CLOSE_MS = 20_000
const MAX_NOT_SENT_RETRIES = 2
const MAX_LOST_REPLAYS = 1
const LANE_POLICY: Record<DesktopLaneName, { responseTimeoutMs: number; abortOnCancel: boolean }> = {
  control: { responseTimeoutMs: 30_000, abortOnCancel: false },
  watch: { responseTimeoutMs: 40_000, abortOnCancel: true },
  status: { responseTimeoutMs: 40_000, abortOnCancel: true },
  bulk: { responseTimeoutMs: 30_000, abortOnCancel: true }
}

// Writes stay on the control lane: cancelling a large read must never tear down an
// in-flight write, and a write is never replayed after its bytes were written.
const writeOperations = new Set([
  'answerQuestion', 'attachmentChunk', 'attachmentCommit', 'attachmentStart',
  'resolveIntent', 'sessionAction', 'sessionDelete', 'sessionFork', 'stop', 'submit'
])
const watchOperations = new Set(['watch'])
const statusOperations = new Set(['liveRuns'])
// `desktop` carries its own kind; history/trace/image reads are the large ones.
const bulkDesktopKinds = new Set(['history', 'trace', 'trace_delta', 'image_chunk'])

export function laneForRequest(request: unknown): DesktopLaneName {
  const op = request && typeof request === 'object' ? (request as { op?: unknown }).op : undefined
  if (typeof op !== 'string') return 'control'
  if (writeOperations.has(op)) return 'control'
  if (watchOperations.has(op)) return 'watch'
  if (statusOperations.has(op)) return 'status'
  if (op === 'desktop') {
    const kind = (request as { query?: { kind?: unknown } }).query?.kind
    return typeof kind === 'string' && bulkDesktopKinds.has(kind) ? 'bulk' : 'control'
  }
  // Long reads and paged payloads: history, trace pages, downloads, file reads.
  return 'bulk'
}

export function replayableRequest(request: unknown): boolean {
  const op = request && typeof request === 'object' ? (request as { op?: unknown }).op : undefined
  return !(typeof op === 'string' && writeOperations.has(op))
}

// Only a host that keeps the tunnel open marks its reply with `keepAlive` first.
// The key may be alone (`{"keepAlive":true}`) when a reply carries no other field.
function isKeepAliveReply(line: string): boolean {
  if (!line.startsWith(KEEP_ALIVE_PREFIX)) return false
  const next = line.charAt(KEEP_ALIVE_PREFIX.length)
  return next === ',' || next === '}'
}

function laneError(message: string): Error {
  return new Error(message)
}

// A send failure proves the bytes never left this process only when the channel
// already knew it was closed and refused the frame outright. A write callback
// error is ambiguous: part of the frame may have reached the host, so a write that
// fails there keeps its outcome unknown instead of being re-sent. Channels mark
// the provable case with this helper; everything else counts as possibly written.
const NOT_SENT = 'desktopLaneNotSent'

/** Bytes provably never left this process: the frame was refused before any write. */
export function laneNotSent(error: Error): Error {
  Object.defineProperty(error, NOT_SENT, { value: true, enumerable: false })
  return error
}

export function laneWasNotSent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<string, unknown>)[NOT_SENT] === true
}

// A TLS 1.3 channel over a unix socket (Desktop, SSH `-L`) or a TCP endpoint
// (tests and the loopback harness). One reply line per request.
export function connectDesktopLane(endpoint: DesktopLaneEndpoint): Promise<DesktopLaneChannel> {
  return new Promise((resolve, reject) => {
    const hasPath = endpoint.path !== undefined
    let socket: TLSSocket
    try {
      socket = tlsConnect({
        ...(hasPath ? { path: endpoint.path as string } : { host: endpoint.host as string, port: endpoint.port as number }),
        ca: endpoint.caPEM,
        cert: endpoint.certPEM,
        key: endpoint.keyPEM,
        servername: 'scry-host',
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        rejectUnauthorized: true
      })
    } catch (error) {
      reject(error instanceof Error ? error : laneError('desktop_lane_connect_failed'))
      return
    }
    let buffer = Buffer.alloc(0)
    let waiter: { resolve(line: string): void; reject(error: Error): void } | undefined
    let closed: Error | undefined
    const closeListeners = new Set<(reason: Error) => void>()
    const fail = (error: Error): void => {
      if (closed) return
      closed = error
      const pending = waiter
      waiter = undefined
      socket.destroy()
      pending?.reject(error)
      for (const listener of closeListeners) listener(error)
      closeListeners.clear()
    }
    const settleLine = (): void => {
      const end = buffer.indexOf(10)
      if (end < 0 || !waiter) return
      const line = buffer.subarray(0, end).toString('utf8')
      buffer = buffer.subarray(end + 1)
      const pending = waiter
      waiter = undefined
      pending.resolve(line)
    }
    socket.once('secureConnect', () => {
      resolve({
        send: frame => new Promise<void>((done, failed) => {
          // Refusing before write is the only provable "not sent": nothing was handed
          // to the socket. The write callback below reports the ambiguous case.
          if (closed) { failed(laneNotSent(closed)); return }
          socket.write(frame, error => { if (error) failed(error); else done() })
        }),
        receive: () => new Promise<string>((done, failed) => {
          if (closed) { failed(closed); return }
          if (waiter) { failed(laneError('desktop_lane_busy')); return }
          waiter = { resolve: done, reject: failed }
          settleLine()
        }),
        destroy: () => fail(laneError('desktop_lane_closed')),
        onClose: listener => {
          if (closed) { listener(closed); return () => undefined }
          closeListeners.add(listener)
          return () => { closeListeners.delete(listener) }
        }
      })
    })
    socket.on('data', (chunk: Buffer) => {
      if (closed) return
      if (buffer.length + chunk.length > MAX_RESPONSE_BYTES) { fail(laneError('desktop_lane_response_too_large')); return }
      buffer = Buffer.concat([buffer, chunk])
      settleLine()
    })
    socket.once('error', error => fail(error instanceof Error ? error : laneError('desktop_lane_socket')))
    socket.once('end', () => fail(laneError('desktop_lane_eof')))
    socket.once('close', () => fail(laneError('desktop_lane_closed')))
  })
}

// A channel belongs to one tunnel path and one device certificate.
function endpointIdentity(endpoint: DesktopLaneEndpoint): string {
  return JSON.stringify([endpoint.path ?? '', endpoint.host ?? '', endpoint.port ?? 0, endpoint.certPEM])
}

interface LaneState {
  queue: Promise<unknown>
  channel?: DesktopLaneChannel
  endpoint?: string
  idle?: NodeJS.Timeout
  // The call whose exchange is on the wire right now. Cancelling a call that is
  // still queued must never tear down the channel another call is using.
  current?: DesktopLaneCall
  // Set when the connection's tunnel goes away. A retired lane never opens a
  // channel again: a reconnect or replay would target a stale tunnel path.
  retired: boolean
}

export interface DesktopLaneCall {
  endpoint: DesktopLaneEndpoint
  request: unknown
  replayable: boolean
  signal?: AbortSignal
}

// Groups one lane set per connection. `closeConnection` is called when the tunnel
// goes away, so a stale channel is never reused on a new tunnel.
export class DesktopLanes {
  readonly #connect: DesktopLaneConnector
  readonly #lanes = new Map<string, LaneState>()

  constructor(connect: DesktopLaneConnector = connectDesktopLane) {
    this.#connect = connect
  }

  request(lane: DesktopLaneName, connectionId: string, call: DesktopLaneCall): Promise<unknown> {
    const key = `${connectionId}\u0000${lane}`
    const state = this.#lanes.get(key) ?? { queue: Promise.resolve(), retired: false }
    this.#lanes.set(key, state)
    const policy = LANE_POLICY[lane]
    const operation = state.queue.then(async () => await this.#exchange(lane, state, call, policy))
    state.queue = operation.then(() => undefined, () => undefined)
    if (!policy.abortOnCancel || !call.signal) return operation
    // Cancelling a read settles the caller at once; the exchange's own later
    // rejection is absorbed so it cannot surface unhandled.
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        // Close only the channel carrying this call; later calls queued on the
        // lane open a fresh channel. A call that has not been written yet drops
        // nothing - the exchange in front of it owns the channel. The cancelled
        // call itself never retries.
        if (state.current === call) this.#dropChannel(state)
        reject(laneError('desktop_lane_cancelled'))
      }
      if (call.signal!.aborted) { onAbort(); return }
      call.signal!.addEventListener('abort', onAbort, { once: true })
      void operation.then(
        value => { call.signal!.removeEventListener('abort', onAbort); resolve(value) },
        error => { call.signal!.removeEventListener('abort', onAbort); reject(error) }
      )
    })
  }

  // The tunnel is gone: retire every lane of this connection. An exchange already
  // waiting for its reply may still settle on its own channel (its outcome is
  // real evidence), but nothing reconnects, replays or starts on a retired lane.
  closeConnection(connectionId: string): void {
    for (const [key, state] of [...this.#lanes]) {
      if (!key.startsWith(`${connectionId}\u0000`)) continue
      this.#lanes.delete(key)
      state.retired = true
      if (!state.current) this.#dropChannel(state)
    }
  }

  // Client disposal: no exchange may outlive it.
  closeAll(): void {
    for (const [key, state] of [...this.#lanes]) {
      this.#lanes.delete(key)
      state.retired = true
      this.#dropChannel(state)
    }
  }

  async #exchange(lane: DesktopLaneName, state: LaneState, call: DesktopLaneCall, policy: { responseTimeoutMs: number; abortOnCancel: boolean }): Promise<unknown> {
    // Nothing was written yet: a pre-dispatch rejection, never an unknown write.
    if (state.retired) throw laneError('desktop_not_connected')
    if (call.signal?.aborted) throw laneError('desktop_lane_cancelled')
    state.current = call
    try { return await this.#exchangeOnLane(lane, state, call, policy) } finally {
      state.current = undefined
      if (state.retired) this.#dropChannel(state)
    }
  }

  async #exchangeOnLane(lane: DesktopLaneName, state: LaneState, call: DesktopLaneCall, policy: { responseTimeoutMs: number; abortOnCancel: boolean }): Promise<unknown> {
    const frame = `${JSON.stringify({ keepAlive: true, ...(call.request as object) })}\n`
    // `reused` is about the attempt that answered: a replay on a new channel is not reused.
    const trace = remoteRequestTrace('remote.client.request')
    const counters = (reused: boolean): Readonly<Record<string, number>> => ({ ...remoteOperationCounters(call.request), [`lane.${lane}`]: 1, reused: reused ? 1 : 0 })
    let reused = false
    trace?.mark('connect_started')
    let notSentRetries = 0
    let lostReplays = 0
    for (;;) {
      let channel: DesktopLaneChannel
      try {
        if (state.retired) throw laneError('desktop_not_connected')
        reused = state.channel !== undefined && state.endpoint === endpointIdentity(call.endpoint)
        channel = await this.#channel(state, call.endpoint)
        // The idle timer only runs between requests: a long poll is not idle.
        this.#clearIdle(state)
        if (!reused) trace?.mark('secure_connected')
      } catch (error) {
        if (!state.retired && !call.signal?.aborted && notSentRetries++ < MAX_NOT_SENT_RETRIES) continue
        trace?.finish(counters(reused), 'error')
        if (state.retired) throw laneError('desktop_not_connected')
        throw error instanceof Error ? error : laneError('desktop_lane_connect_failed')
      }
      try {
        await channel.send(frame)
        trace?.mark('request_written')
      } catch (error) {
        this.#dropChannel(state)
        // Refused before any write: safe to re-send on a new channel, for a read
        // and for a write alike.
        if (laneWasNotSent(error) && !state.retired && !call.signal?.aborted && notSentRetries++ < MAX_NOT_SENT_RETRIES) continue
        // The write itself failed: bytes may have reached the host, so only a
        // replayable read may try again once. A write reports an unproven outcome.
        if (!state.retired && !call.signal?.aborted && call.replayable && lostReplays++ < MAX_LOST_REPLAYS) continue
        trace?.finish(counters(reused), 'error')
        if (state.retired) throw laneError('desktop_not_connected')
        throw error instanceof Error ? error : laneError('desktop_lane_not_sent')
      }
      let line: string
      try {
        line = await this.#awaitReply(channel, policy.responseTimeoutMs)
      } catch (error) {
        this.#dropChannel(state)
        // Bytes were written: the host may have acted on them. Only a replayable
        // read may try once more; a write reports an unproven outcome.
        if (!state.retired && !call.signal?.aborted && call.replayable && lostReplays++ < MAX_LOST_REPLAYS) continue
        trace?.finish(counters(reused), 'error')
        throw error instanceof Error ? error : laneError('desktop_lane_lost')
      }
      trace?.mark('first_byte')
      if (!isKeepAliveReply(line)) {
        // An older host closes after each reply. Falling back to one-shot requests
        // would hide that mismatch behind a second protocol.
        this.#dropChannel(state)
        trace?.finish(counters(reused), 'error')
        throw laneError('desktop_protocol_mismatch')
      }
      let value: Record<string, unknown>
      try { value = JSON.parse(line) as Record<string, unknown> } catch {
        this.#dropChannel(state)
        trace?.finish(counters(reused), 'error')
        throw laneError('desktop_protocol_mismatch')
      }
      // The marker belongs to the transport, not to the reply the caller reads.
      delete value.keepAlive
      this.#armIdle(state)
      trace?.mark('response_parsed')
      trace?.finish(counters(reused))
      return value
    }
  }

  #awaitReply(channel: DesktopLaneChannel, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false
      // onClose calls the listener at once when the channel is already closed.
      let remove: (() => void) | undefined
      const settle = (error: Error | undefined, line?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        remove?.()
        if (error) reject(error)
        else resolve(line as string)
      }
      const timer = setTimeout(() => {
        // Settle first: the close the destroy triggers must not replace the reason.
        settle(laneError('desktop_lane_timeout'))
        channel.destroy()
      }, timeoutMs)
      timer.unref()
      remove = channel.onClose(reason => settle(reason))
      if (settled) remove()
      void channel.receive().then(
        line => settle(undefined, line),
        error => settle(error instanceof Error ? error : laneError('desktop_lane_closed'))
      )
    })
  }

  async #channel(state: LaneState, endpoint: DesktopLaneEndpoint): Promise<DesktopLaneChannel> {
    const identity = endpointIdentity(endpoint)
    if (state.channel && state.endpoint === identity) return state.channel
    // A new tunnel (or a new device certificate) invalidates the old channel.
    if (state.channel) this.#dropChannel(state)
    // Requests on a lane are serialized, so there is never a concurrent open.
    const channel = await this.#connect(endpoint)
    state.channel = channel
    state.endpoint = identity
    channel.onClose(() => { if (state.channel === channel) { state.channel = undefined; state.endpoint = undefined } })
    return channel
  }

  #armIdle(state: LaneState): void {
    this.#clearIdle(state)
    state.idle = setTimeout(() => { this.#dropChannel(state) }, IDLE_CLOSE_MS)
    state.idle.unref()
  }

  #clearIdle(state: LaneState): void {
    if (state.idle) { clearTimeout(state.idle); state.idle = undefined }
  }

  #dropChannel(state: LaneState): void {
    this.#clearIdle(state)
    const channel = state.channel
    state.channel = undefined
    state.endpoint = undefined
    channel?.destroy()
  }
}