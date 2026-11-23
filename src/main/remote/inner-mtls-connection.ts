import type { TLSSocket } from 'node:tls'
import { INNER_IDLE_TIMEOUT_MS, isMuxId, MAX_MUX_INFLIGHT } from './inner-mtls-protocol'

// Framing and lane modes for ONE authenticated phone
// connection. The caller has already verified the TLS 1.3 peer certificate and
// derived `fingerprint` from it; every request is still authorized by the
// controller against that fingerprint.
export interface InnerConnectionContext {
  certificateExpiresAt: number
  maxFrame: number
  // Checked for every frame before anything runs: a reply
  // here (a transport-scope denial, a protocol refusal, `daemonInfo`) is sent as is.
  preflight?(request: Record<string, unknown> | undefined): Record<string, unknown> | undefined
  dispatch(request: Record<string, unknown> | undefined): Promise<unknown>
  // Per-request timing of a dispatched request (remote-request-timing.ts).
  timing?(request: Record<string, unknown> | undefined): RequestTiming | undefined
}

export interface RequestTiming {
  settled(response: unknown): void
  written(): void
  failed(): void
}

export function serveInnerConnection(socket: TLSSocket, context: InnerConnectionContext): void {
  const { certificateExpiresAt } = context
  let buffer: Buffer = Buffer.alloc(0)
  let busy = false
  let kept = false
  // Multiplexed mode: entered by a kept-alive request carrying a numeric
  // `id`. Requests then run concurrently and each reply echoes its id, so a
  // long-poll no longer blocks commands and one tunnel replaces several.
  // Authorization is unchanged: every request is still checked against the
  // verified peer fingerprint.
  let mux = false
  let inflight = 0
  // Diagnostics only: name why the host tore a channel down, because the device
  // sees every host-side destroy as the same relay `peer_closed`.
  const abort = (reason: string): void => {
    if (process.env.SCRY_INNER_MTLS_DEBUG) console.log(`[inner-mtls] destroy reason=${reason} buffered=${buffer.length}`)
    socket.destroy()
  }
  // This is an idle timeout, not a computation deadline. A history/archive
  // read may legitimately take longer than 30 seconds; the client can cancel
  // the TLS channel when its request is superseded. Disable the idle timer
  // while dispatching and arm it again only after a response is written.
  // One listener for the connection's lifetime; re-arming only resets the timer.
  // Passing a callback per arm would stack a listener per keep-alive request.
  socket.on('timeout', () => abort('idle_timeout'))
  const armIdleTimeout = (): void => { socket.setTimeout(INNER_IDLE_TIMEOUT_MS) }
  armIdleTimeout()
  const writeLine = (value: unknown): void => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n') }
  const dispatchMux = (id: number, request: Record<string, unknown>): void => {
    const early = context.preflight?.(request)
    if (early) { writeLine({ keepAlive: true, id, ...early }); return }
    if (inflight >= MAX_MUX_INFLIGHT) {
      socket.write(JSON.stringify({ keepAlive: true, id, error: 'mux_busy' }) + '\n')
      return
    }
    inflight++
    socket.setTimeout(0)
    const timing = context.timing?.(request)
    void context.dispatch(request)
      .then((res) => {
        inflight--
        timing?.settled(res)
        if (socket.destroyed) { timing?.failed(); return }
        // keepAlive then id must be the first keys: clients match this prefix.
        const { id: _id, keepAlive: _keepAlive, ...body } = (res ?? {}) as Record<string, unknown>
        socket.write(JSON.stringify({ keepAlive: true, id, ...body }) + '\n')
        timing?.written()
        if (inflight === 0) armIdleTimeout()
      })
      .catch((error) => {
        timing?.failed()
        abort(`dispatch_threw:${String((error as Error)?.message ?? error).slice(0, 200)}`)
      })
  }
  socket.on('data', (bytes: Buffer) => {
    if (!mux && busy) { abort('data_while_busy'); return }
    if (Date.now() >= certificateExpiresAt) { abort('certificate_expired'); return }
    // A multiplexed lane may hold one partial line behind complete ones.
    const bound = mux ? context.maxFrame * 2 : context.maxFrame
    if (buffer.length + bytes.length > bound) { abort(`frame_too_large:${buffer.length + bytes.length}`); return }
    buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes])
    for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
      if (end > context.maxFrame) { abort(`frame_too_large:${end}`); return }
      const frame = buffer.subarray(0, end)
      buffer = end === buffer.length - 1 ? Buffer.alloc(0) : Buffer.from(buffer.subarray(end + 1))
      let parsed: Record<string, unknown> | undefined
      try {
        const value: unknown = JSON.parse(frame.toString('utf8'))
        if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
      } catch { /* dispatch reports malformed JSON */ }
      const keepAlive = parsed?.keepAlive === true
      const id = parsed?.id
      if (!mux && keepAlive && isMuxId(id)) { mux = true; kept = true }
      if (mux) {
        if (!parsed || !keepAlive || !isMuxId(id)) {
          socket.end(JSON.stringify({ keepAlive: true, error: 'mux_id_required' }) + '\n')
          return
        }
        const { id: _id, ...request } = parsed
        dispatchMux(id, request)
        continue
      }
      // One outstanding request, never pipelined commands; every request still
      // checks the device grant inside HostController.
      if (buffer.length > 0) { abort('pipelined_request'); return }
      if (kept && !keepAlive) { socket.end(JSON.stringify({ error: 'keep_alive_required' }) + '\n'); return }
      kept ||= keepAlive
      const early = context.preflight?.(parsed)
      if (early) {
        if (keepAlive) { socket.write(`${JSON.stringify({ keepAlive: true, ...early })}\n`); armIdleTimeout() }
        else socket.end(`${JSON.stringify(early)}\n`)
        continue
      }
      busy = true
      socket.setTimeout(0)
      const timing = context.timing?.(parsed)
      void context.dispatch(parsed)
        .then((res) => {
          busy = false
          timing?.settled(res)
          if (keepAlive) {
            // keepAlive must be the first key: clients check this exact prefix.
            const reply = JSON.stringify({ keepAlive: true, ...(res as object) }) + '\n'
            socket.write(reply)
            timing?.written()
            armIdleTimeout()
          } else {
            socket.end(JSON.stringify(res) + '\n')
            timing?.written()
          }
        })
        .catch((error) => {
          timing?.failed()
          abort(`dispatch_threw:${String((error as Error)?.message ?? error).slice(0, 200)}`)
        })
    }
  })
  socket.on('error', (error) => {
    // Peer reset; nothing to report to the device.
    if (process.env.SCRY_INNER_MTLS_DEBUG) console.log(`[inner-mtls] socket error: ${error.message}`)
  })
  if (process.env.SCRY_INNER_MTLS_DEBUG) {
    socket.once('close', (hadError) => console.log(`[inner-mtls] close hadError=${hadError} busy=${busy} buffered=${buffer.length}`))
  }
}
