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
//   workbench: file writes, Git/PR mutations, PTY input (a push may take 30 s; a stop
//            or an answer must not wait behind it)
//   terminal: the daemon App's terminal input and output (a keystroke must not wait
//            behind a history page)
//   long:    the daemon App's rare calls that may outlast 30 s: MCP snapshot/test/re-auth
//            (an OAuth sign-in, a first npx install) and the paginated billing sync
//   watch:   one run's long-poll
//   status:  the live-run long-poll
//   events:  the App's event-feed long-poll (daemon mode only)
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
import { laneNotSent, laneWasNotSent, laneOutcomeUnknown } from './desktop-lane-phase'
export { laneNotSent, laneOutcomeUnknown, laneWasNotSent, laneWasWrittenUnknown } from './desktop-lane-phase'

export type { DesktopLaneName } from './desktop-lane-policy'
import { LANE_POLICY, type DesktopLaneName } from './desktop-lane-policy'
export { laneForRequest, replayableRequest } from './desktop-lane-routing'

import { connectDesktopLane, MAX_RESPONSE_BYTES, type DesktopLaneChannel, type DesktopLaneEndpoint } from './desktop-lane-channel'
export { connectDesktopLane, type DesktopLaneChannel, type DesktopLaneEndpoint } from './desktop-lane-channel'

export type DesktopLaneConnector = (endpoint: DesktopLaneEndpoint, options?: { signal?: AbortSignal }) => Promise<DesktopLaneChannel>

const KEEP_ALIVE_PREFIX = '{"keepAlive":true'
// Close before the host's idle timeout (30 s on older hosts, 75 s since lanes can
// multiplex), so a request is never written into a tunnel the host is about to drop.
const IDLE_CLOSE_MS = 20_000
const MAX_NOT_SENT_RETRIES = 2
const MAX_LOST_REPLAYS = 1

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

function endpointIdentity(endpoint: DesktopLaneEndpoint): string {
  return JSON.stringify([endpoint.path ?? '', endpoint.host ?? '', endpoint.port ?? 0, endpoint.certPEM, endpoint.maxResponseBytes ?? MAX_RESPONSE_BYTES])
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
  subscriber?: string
  signal?: AbortSignal
}

export class DesktopLanes {
  readonly #connect: DesktopLaneConnector
  readonly #lanes = new Map<string, LaneState>()

  constructor(connect: DesktopLaneConnector = connectDesktopLane) {
    this.#connect = connect
  }

  request(lane: DesktopLaneName, connectionId: string, call: DesktopLaneCall): Promise<unknown> {
    const key = `${connectionId}\u0000${lane}${call.subscriber ? `:${call.subscriber}` : ''}`
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
        const signal = policy.abortOnCancel ? call.signal : undefined
        channel = await this.#channel(state, call.endpoint, signal)
        if (signal?.aborted) {
          this.#dropChannel(state)
          throw laneError('desktop_lane_cancelled')
        }
        // The idle timer only runs between requests: a long poll is not idle.
        this.#clearIdle(state)
        if (!reused) trace?.mark('secure_connected')
      } catch (error) {
        if (!state.retired && !call.signal?.aborted && notSentRetries++ < MAX_NOT_SENT_RETRIES) continue
        trace?.finish(counters(reused), 'error')
        if (state.retired) throw laneError('desktop_not_connected')
        throw laneNotSent(error instanceof Error ? error : laneError('desktop_lane_connect_failed'))
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
        throw laneOutcomeUnknown(error instanceof Error ? error : laneError('desktop_lane_not_sent'))
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
        throw laneOutcomeUnknown(error instanceof Error ? error : laneError('desktop_lane_lost'))
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

  async #channel(state: LaneState, endpoint: DesktopLaneEndpoint, signal?: AbortSignal): Promise<DesktopLaneChannel> {
    const identity = endpointIdentity(endpoint)
    if (state.channel && state.endpoint === identity) return state.channel
    if (state.channel) this.#dropChannel(state)
    // Requests on a lane are serialized, so there is never a concurrent open.
    const channel = signal ? await this.#connect(endpoint, { signal }) : await this.#connect(endpoint)
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
