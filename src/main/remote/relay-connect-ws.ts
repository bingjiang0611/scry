import { Duplex } from 'node:stream'
import type { OutboundLeg } from './relay-client'

// Host-side outbound leg for the Cloudflare Worker relay. On Cloudflare the relay
// speaks WebSocket (Workers cannot accept arbitrary inbound TCP), so the Mac host
// dials each warm reverse-tunnel leg over WSS and adapts it to the Duplex that
// InnerMtlsHost/PairingTransport serve. This uses the Node/Electron GLOBAL
// WebSocket (Node 22+/Electron 42), so Electron main gains no `ws` dependency.
//
// It adds no security: the inner TLS 1.3 mTLS still runs end-to-end over these
// bytes. The first frame is the JSON { token } auth the Worker validates; every
// subsequent binary frame is opaque inner-TLS ciphertext.
export interface RelayWSOptions {
  // Base URL of the relay, e.g. wss://scry-relay.example.workers.dev (no path).
  url: string
  hostId: string
  token: string
  mode: 'run' | 'pair'
}

export function createRelayConnectWS(opts: RelayWSOptions): { connect: () => OutboundLeg; readyEvent: 'connect' } {
  return { connect: () => wsLeg(opts), readyEvent: 'connect' }
}

function wsLeg(opts: RelayWSOptions): OutboundLeg {
  const base = opts.url.replace(/\/+$/, '')
  const url = `${base}/host?host=${encodeURIComponent(opts.hostId)}&mode=${opts.mode}`
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      try { ws.send(chunk as Uint8Array); cb() }
      catch (err) { cb(err as Error) }
    },
    final(cb) { try { ws.close(1000) } catch { /* already closing */ } cb() },
    destroy(err, cb) { try { ws.close() } catch { /* already closing */ } cb(err) }
  })
  ws.addEventListener('open', () => {
    // Authenticate the leg, then hand it to ReverseTunnelTransport via 'connect'.
    ws.send(JSON.stringify({ token: opts.token }))
    duplex.emit('connect')
  })
  ws.addEventListener('message', (event: MessageEvent) => {
    const data = event.data
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data as ArrayBuffer)
    duplex.push(buf)
  })
  ws.addEventListener('close', () => { duplex.push(null); if (!duplex.destroyed) duplex.destroy() })
  ws.addEventListener('error', () => { if (!duplex.destroyed) duplex.destroy(new Error('relay_ws_error')) })
  return duplex
}
