import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { OutboundLeg } from './relay-client'

// Production, dependency-free outer-leg factory for ReverseTunnelTransport. It
// dials the relay's host listener and, once the outer connection is up, writes a
// one-line JSON auth frame identifying this host. After that first line the
// stream carries only inner-TLS 1.3 ciphertext, which the relay shuttles to the
// device without parsing.
//
// No WebSocket / `ws` dependency is added to the Electron app: the host<->relay
// leg is a plain byte stream (raw TCP, or TLS for outer confidentiality +
// relay-endpoint authentication). Only the device leg is WSS (iOS URLSession).
// When `tls` is provided the inner mTLS runs inside the outer TLS (TLS-in-TLS),
// so the relay sees only doubly-wrapped ciphertext on the path.

export interface RelayConnectOptions {
  host: string
  port: number
  // Stable host identity the relay routes by (matches the pairing anchor's host).
  hostId: string
  // Per-host bearer token provisioned out of band; NEVER logged.
  token: string
  // Which host endpoint the relay should bridge this leg to: 'run' (granted
  // devices, strict mTLS) or 'pair' (pairing devices, self-signed prove). The
  // relay keeps a separate warm pool per mode.
  mode: 'run' | 'pair'
  // Outer TLS to the relay. Omit for a plain TCP leg (inner mTLS still protects
  // all content end-to-end; outer TLS only adds path confidentiality + relay
  // endpoint auth).
  tls?: { ca?: string; servername?: string; rejectUnauthorized?: boolean }
}

export interface RelayConnectFactory {
  connect: () => OutboundLeg
  // Pass to ReverseTunnelTransport so it serves inner mTLS only once the correct
  // outer-readiness event has fired.
  readyEvent: 'connect' | 'secureConnect'
}

export function createRelayConnect(opts: RelayConnectOptions): RelayConnectFactory {
  const authLine = JSON.stringify({ hostId: opts.hostId, token: opts.token, mode: opts.mode }) + '\n'
  const useTls = Boolean(opts.tls)
  const readyEvent = useTls ? 'secureConnect' : 'connect'
  const connect = (): OutboundLeg => {
    const socket = useTls
      ? tlsConnect({ host: opts.host, port: opts.port, ca: opts.tls!.ca, servername: opts.tls!.servername, rejectUnauthorized: opts.tls!.rejectUnauthorized ?? true })
      : netConnect({ host: opts.host, port: opts.port })
    // Write the auth line before the transport serves inner mTLS on the same
    // readiness event. Listener order guarantees this runs first: the factory
    // registers here, the transport registers its serve() listener afterwards.
    socket.once(readyEvent, () => {
      try { socket.write(authLine) } catch { socket.destroy() }
    })
    return socket as unknown as OutboundLeg
  }
  return { connect, readyEvent }
}
