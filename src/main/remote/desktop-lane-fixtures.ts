import { laneNotSent, type DesktopLaneChannel, type DesktopLaneConnector, type DesktopLaneEndpoint } from './desktop-lane'


function requestOf(frame: string): Record<string, unknown> {
  const { keepAlive: _keepAlive, ...request } = JSON.parse(frame) as Record<string, unknown>
  return request
}

// A reply the handler already encoded as one JSON object. The fake channel frames it
// as the host does (`{"keepAlive":true,...}`) instead of decoding and re-encoding it,
// so a measurement fixture pays one encode and one decode per reply, like production.
export class EncodedLaneReply {
  constructor(readonly json: string) {
    if (!json.startsWith('{') || !json.endsWith('}')) throw new Error('encoded lane reply must be a JSON object')
  }
}

function replyLine(value: unknown): string {
  if (!(value instanceof EncodedLaneReply)) return JSON.stringify({ keepAlive: true, ...(value as object) })
  const body = value.json.slice(1)
  return body.trim() === '}' ? '{"keepAlive":true}' : `{"keepAlive":true,${body}`
}

// Routes lane frames to a one-shot style handler, so tests that fake the wire
// still drive the production lane client (keep-alive replies, one outstanding
// request, close on failure). A handler that throws models a lost reply: the
// channel closes after the bytes were written.
export function fakeLaneConnector(handler: (options: { path: string; request: unknown }) => Promise<unknown>): DesktopLaneConnector {
  return async (endpoint: DesktopLaneEndpoint): Promise<DesktopLaneChannel> => {
    let closed: Error | undefined
    const lines: string[] = []
    let deliver: { resolve(line: string): void; reject(error: Error): void } | undefined
    const listeners = new Set<(reason: Error) => void>()
    const close = (reason: Error): void => {
      if (closed) return
      closed = reason
      deliver?.reject(reason)
      deliver = undefined
      for (const listener of [...listeners]) listener(reason)
      listeners.clear()
    }
    return {
      send: async frame => {
        if (closed) throw laneNotSent(closed)
        void handler({ path: endpoint.path ?? '', request: requestOf(frame) }).then(
          value => {
            if (closed) return
            const line = replyLine(value)
            if (deliver) { const done = deliver; deliver = undefined; done.resolve(line) } else lines.push(line)
          },
          error => close(error instanceof Error ? error : new Error('desktop_lane_closed'))
        )
      },
      receive: async () => {
        if (closed) throw closed
        const queued = lines.shift()
        if (queued !== undefined) return queued
        return await new Promise<string>((resolve, reject) => { deliver = { resolve, reject } })
      },
      destroy: () => close(new Error('desktop_lane_closed')),
      onClose: listener => {
        if (closed) { listener(closed); return () => undefined }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }
    }
  }
}

export type LaneFault = 'deliver' | 'drop_before_delivery' | 'drop_reply'

// Wraps a real lane connector to observe each request and inject one transport
// fault. `drop_before_delivery` reports the bytes as written but never delivers
// them (the outcome is unknown to the client); `drop_reply` delivers the request
// and loses the reply.
export function faultyLaneConnector(connect: DesktopLaneConnector, onRequest: (request: Record<string, unknown>, endpoint: DesktopLaneEndpoint) => LaneFault): DesktopLaneConnector {
  return async (endpoint: DesktopLaneEndpoint): Promise<DesktopLaneChannel> => {
    const channel = await connect(endpoint)
    let dropReply = false
    return {
      send: async frame => {
        const fault = onRequest(requestOf(frame), endpoint)
        if (fault === 'drop_before_delivery') { channel.destroy(); return }
        dropReply = fault === 'drop_reply'
        await channel.send(frame)
      },
      receive: async () => {
        const line = await channel.receive()
        if (!dropReply) return line
        dropReply = false
        channel.destroy()
        throw new Error('desktop_lane_closed')
      },
      destroy: () => channel.destroy(),
      onClose: listener => channel.onClose(listener)
    }
  }
}
