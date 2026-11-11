import type { TLSSocket } from 'node:tls'
import type { HostController } from './host-controller'
import { INNER_IDLE_TIMEOUT_MS, isMuxId, MAX_MUX_INFLIGHT, MAX_STREAMS_PER_LANE, WATCH_STREAM_MAX_MS, WATCH_STREAM_WAIT_MS } from './inner-mtls-protocol'

// Framing, lane modes and pushed streams for ONE authenticated phone
// connection. The caller has already verified the TLS 1.3 peer certificate and
// derived `fingerprint` from it; every request is still authorized by the
// controller against that fingerprint.
export interface InnerConnectionContext {
  controller: HostController
  fingerprint: string
  certificateExpiresAt: number
  maxFrame: number
  dispatch(request: Record<string, unknown> | undefined): Promise<unknown>
}

export function serveInnerConnection(socket: TLSSocket, context: InnerConnectionContext): void {
  const { controller, fingerprint, certificateExpiresAt } = context
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
  const streams = new Map<number, { cancelled: boolean }>()
  const writeLine = (value: unknown): void => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n') }
  const errorCode = (error: unknown): string =>
    String((error as { code?: string })?.code ?? (error as Error)?.message ?? 'error').slice(0, 64)
  const runWatchStream = async (id: number, input: { runId: string; cursor: number; outputCursor: number }): Promise<void> => {
    const state = { cancelled: false }
    streams.set(id, state)
    const startedAt = Date.now()
    let { cursor, outputCursor } = input
    try {
      while (!state.cancelled && !socket.destroyed) {
        let watch: Awaited<ReturnType<HostController['watchRun']>>
        // Every pass re-authorizes the verified peer inside the controller.
        try { watch = await controller.watchRun(fingerprint, { runId: input.runId, cursor, outputCursor, waitMs: WATCH_STREAM_WAIT_MS }) }
        catch (error) { writeLine({ keepAlive: true, id, error: errorCode(error) }); return }
        if (state.cancelled || socket.destroyed) return
        const terminal = watch.state === 'settled' || watch.state === 'failed' || watch.state === 'cancelled'
        const more = !terminal && Date.now() - startedAt < WATCH_STREAM_MAX_MS
        // keepAlive, id, more: clients match this prefix to keep the id open.
        writeLine({ keepAlive: true, id, more, watch })
        if (!more) return
        cursor = watch.poll.cursor
        outputCursor = watch.output.cursor
      }
    } finally {
      streams.delete(id)
    }
  }
  const dispatchMux = (id: number, request: Record<string, unknown>): void => {
    if (request.op === 'cancel') {
      // Stops a pushed stream this lane opened; nothing else can be cancelled.
      const target = request.target
      if (Object.keys(request).some((key) => !['op', 'target', 'keepAlive', 'deviceLabel'].includes(key)) || !isMuxId(target)) {
        writeLine({ keepAlive: true, id, error: 'invalid_request' })
        return
      }
      const stream = streams.get(target)
      if (stream) stream.cancelled = true
      writeLine({ keepAlive: true, id, cancelled: stream !== undefined })
      return
    }
    if (request.op === 'watchStream') {
      const { runId, cursor, outputCursor } = request
      if (Object.keys(request).some((key) => !['op', 'runId', 'cursor', 'outputCursor', 'keepAlive', 'deviceLabel'].includes(key)) ||
          typeof runId !== 'string' || !Number.isSafeInteger(cursor) || !Number.isSafeInteger(outputCursor)) {
        writeLine({ keepAlive: true, id, error: 'invalid_request' })
        return
      }
      if (streams.size >= MAX_STREAMS_PER_LANE || inflight >= MAX_MUX_INFLIGHT) {
        writeLine({ keepAlive: true, id, error: 'mux_busy' })
        return
      }
      inflight++
      socket.setTimeout(0)
      void runWatchStream(id, { runId, cursor: cursor as number, outputCursor: outputCursor as number })
        .catch((error) => abort(`stream_threw:${String((error as Error)?.message ?? error).slice(0, 200)}`))
        .finally(() => { inflight--; if (inflight === 0 && !socket.destroyed) armIdleTimeout() })
      return
    }
    if (inflight >= MAX_MUX_INFLIGHT) {
      socket.write(JSON.stringify({ keepAlive: true, id, error: 'mux_busy' }) + '\n')
      return
    }
    inflight++
    socket.setTimeout(0)
    void context.dispatch(request)
      .then((res) => {
        inflight--
        if (socket.destroyed) return
        // keepAlive then id must be the first keys: clients match this prefix.
        const { id: _id, keepAlive: _keepAlive, ...body } = (res ?? {}) as Record<string, unknown>
        socket.write(JSON.stringify({ keepAlive: true, id, ...body }) + '\n')
        if (inflight === 0) armIdleTimeout()
      })
      .catch((error) => abort(`dispatch_threw:${String((error as Error)?.message ?? error).slice(0, 200)}`))
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
      busy = true
      socket.setTimeout(0)
      void context.dispatch(parsed)
        .then((res) => {
          busy = false
          if (keepAlive) {
            // keepAlive must be the first key: clients check this exact prefix.
            const reply = JSON.stringify({ keepAlive: true, ...(res as object) }) + '\n'
            socket.write(reply)
            armIdleTimeout()
          } else socket.end(JSON.stringify(res) + '\n')
        })
        .catch((error) => abort(`dispatch_threw:${String((error as Error)?.message ?? error).slice(0, 200)}`))
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
