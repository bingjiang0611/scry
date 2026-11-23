import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { laneNotSent } from './desktop-lane-phase'

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export interface DesktopLaneEndpoint {
  path?: string
  host?: string
  port?: number
  caPEM: string
  certPEM: string
  keyPEM: string
  /** Full-page replies on the App's authenticated local history lane only. */
  maxResponseBytes?: number
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

// A TLS 1.3 channel over a unix socket (Desktop, SSH `-L`) or a TCP endpoint
// (tests and the loopback harness). One reply line per request.
// A listener that accepts and never handshakes keeps `secureConnect` pending forever
// (a daemon killed mid-restart leaves exactly that in the kernel's accept backlog).
// Nothing is written before the handshake, so this failure is provably "not sent".
const CONNECT_TIMEOUT_MS = 5_000

export function connectDesktopLane(
  endpoint: DesktopLaneEndpoint,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<DesktopLaneChannel> {
  return new Promise((resolve, reject) => {
    const { signal } = options
    if (signal?.aborted) {
      reject(laneNotSent(new Error('desktop_lane_cancelled')))
      return
    }
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
      reject(error instanceof Error ? error : new Error('desktop_lane_connect_failed'))
      return
    }
    const maxResponseBytes = endpoint.maxResponseBytes ?? MAX_RESPONSE_BYTES
    // TLS can split a long UTF-8 reply across thousands of chunks. Scan each chunk
    // once and join only when a complete reply is ready, not on every data event.
    let parts: Buffer[] = []
    let bufferedBytes = 0
    let lineEnd = -1
    let waiter: { resolve(line: string): void; reject(error: Error): void } | undefined
    let closed: Error | undefined
    const closeListeners = new Set<(reason: Error) => void>()
    let resolved = false
    const cancelHandshake = (): void => fail(laneNotSent(new Error('desktop_lane_cancelled')))
    const fail = (error: Error): void => {
      if (closed) return
      closed = error
      clearTimeout(connectTimer)
      signal?.removeEventListener('abort', cancelHandshake)
      // Before the handshake there is no channel to hand back: the caller waits on the
      // connect promise itself, so that is what has to settle.
      if (!resolved) { resolved = true; reject(error) }
      const pending = waiter
      waiter = undefined
      parts = []
      socket.destroy()
      pending?.reject(error)
      for (const listener of closeListeners) listener(error)
      closeListeners.clear()
    }
    const settleLine = (): void => {
      if (lineEnd < 0 || !waiter) return
      const buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts, bufferedBytes)
      const line = buffer.toString('utf8', 0, lineEnd)
      const rest = buffer.subarray(lineEnd + 1)
      parts = rest.length ? [rest] : []
      bufferedBytes = rest.length
      lineEnd = rest.indexOf(10)
      const pending = waiter
      waiter = undefined
      pending.resolve(line)
    }
    const connectTimer = setTimeout(
      () => fail(laneNotSent(new Error('desktop_lane_connect_timeout'))),
      options.timeoutMs ?? CONNECT_TIMEOUT_MS
    )
    socket.once('secureConnect', () => {
      if (closed) return
      clearTimeout(connectTimer)
      signal?.removeEventListener('abort', cancelHandshake)
      resolved = true
      resolve({
        send: frame => new Promise<void>((done, failed) => {
          // Refusing before write is the only provable "not sent": nothing was handed
          // to the socket. The write callback below reports the ambiguous case.
          if (closed) { failed(laneNotSent(closed)); return }
          socket.write(frame, error => { if (error) failed(error); else done() })
        }),
        receive: () => new Promise<string>((done, failed) => {
          if (closed) { failed(closed); return }
          if (waiter) { failed(new Error('desktop_lane_busy')); return }
          waiter = { resolve: done, reject: failed }
          settleLine()
        }),
        destroy: () => fail(new Error('desktop_lane_closed')),
        onClose: listener => {
          if (closed) { listener(closed); return () => undefined }
          closeListeners.add(listener)
          return () => { closeListeners.delete(listener) }
        }
      })
    })
    socket.on('data', (chunk: Buffer) => {
      if (closed) return
      if (bufferedBytes + chunk.length > maxResponseBytes) { fail(new Error('desktop_lane_response_too_large')); return }
      if (lineEnd < 0) {
        const end = chunk.indexOf(10)
        if (end >= 0) lineEnd = bufferedBytes + end
      }
      parts.push(chunk)
      bufferedBytes += chunk.length
      settleLine()
    })
    socket.once('error', error => fail(error instanceof Error ? error : new Error('desktop_lane_socket')))
    socket.once('end', () => fail(new Error('desktop_lane_eof')))
    socket.once('close', () => fail(new Error('desktop_lane_closed')))
    signal?.addEventListener('abort', cancelHandshake, { once: true })
  })
}
