import type { Duplex } from 'node:stream'

// Anything that can run a protocol server over a relay-delivered byte stream
// (InnerMtlsHost for granted devices, PairingTransport for pairing devices).
export interface StreamServer {
  serve(stream: Duplex): void
}

// Mac relay client: the Scry host is typically behind NAT, so it dials OUT to
// the public relay and the relay glues each arriving device to one of the
// host's outbound legs (a reverse tunnel). The relay only shuttles ciphertext;
// the inner TLS 1.3 mTLS still runs end-to-end between device and InnerMtlsHost,
// so a compromised or malicious relay cannot read or forge inner traffic - it
// can at most drop/delay bytes. Host<->relay authentication (routing integrity)
// and the outer TLS/WSS wrapping are the transport's responsibility (injected),
// not this bridge's.

export interface RelayTransport {
  // Begin producing device session streams. Each emitted duplex is one device's
  // outer leg; the caller runs inner mTLS over it. Errors that are not fatal to
  // the tunnel are reported but must not tear down the host.
  start(onSession: (stream: Duplex) => void, onError?: (error: Error) => void): Promise<void>
  close(): Promise<void>
}

export class RelayClient {
  #host: StreamServer
  #transport: RelayTransport
  #started = false

  constructor(deps: { host: StreamServer; transport: RelayTransport }) {
    this.#host = deps.host
    this.#transport = deps.transport
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('relay_client_already_started')
    this.#started = true
    await this.#transport.start((stream) => this.#bridge(stream))
  }

  #bridge(stream: Duplex): void {
    // A single malformed or hostile session must never crash the host: isolate
    // every bridge. The inner mTLS host fails closed on the stream itself for any
    // unauthenticated/unauthorized peer.
    stream.on('error', () => { stream.destroy() })
    try {
      this.#host.serve(stream)
    } catch {
      stream.destroy()
    }
  }

  async close(): Promise<void> {
    if (!this.#started) return
    this.#started = false
    await this.#transport.close()
  }
}

// A RelayTransport that maintains a warm pool of outbound connections to the
// relay (a classic reverse tunnel). `connect` yields one outer leg (in
// production a TLS/WSS-wrapped socket authenticated to the relay); the pool is
// replenished as sessions are consumed so a device never waits for the host to
// dial. This class owns only the pool lifecycle - it makes no security
// decisions; inner mTLS and relay authentication live elsewhere.
// A connection-oriented outer leg (e.g. a net.Socket, or a TLS/WSS-wrapped
// socket). It must emit 'connect' when the outer connection is established and
// 'close' when it ends. WSS legs also emit 'relaySession' on their first inbound
// ciphertext, so a long-lived history read does not consume the waiting pool.
export type OutboundLeg = Duplex

export class ReverseTunnelTransport implements RelayTransport {
  #connect: () => OutboundLeg
  #poolSize: number
  #readyEvent: string
  #closed = false
  #legs = new Set<OutboundLeg>()
  #waiting = new Set<OutboundLeg>()
  #onSession: ((stream: Duplex) => void) | null = null

  // readyEvent is the event that signals the outer leg is up and safe to serve
  // inner mTLS over: 'connect' for a plain TCP leg, 'secureConnect' for an outer
  // TLS leg (TLS-in-TLS: inner mTLS runs inside the host<->relay outer TLS).
  constructor(deps: { connect: () => OutboundLeg; poolSize?: number; readyEvent?: string }) {
    this.#connect = deps.connect
    this.#poolSize = Math.max(1, deps.poolSize ?? 2)
    this.#readyEvent = deps.readyEvent ?? 'connect'
  }

  async start(onSession: (stream: Duplex) => void): Promise<void> {
    if (this.#onSession) throw new Error('reverse_tunnel_already_started')
    this.#onSession = onSession
    this.#fillPool()
  }

  #fillPool(): void {
    // Keep idle reserve separate from active transfers. Bound unauthenticated
    // ciphertext-driven expansion; at capacity the relay can still say busy.
    // Default: two waiting, at most eight total; raising this needs load evidence.
    while (!this.#closed && this.#waiting.size < this.#poolSize && this.#legs.size < this.#poolSize * 4) this.#spawn()
  }

  #spawn(): void {
    if (this.#closed || !this.#onSession) return
    const leg = this.#connect()
    this.#legs.add(leg)
    this.#waiting.add(leg)
    leg.once('relaySession', () => {
      this.#waiting.delete(leg)
      this.#fillPool()
    })
    leg.on('error', () => { /* the bridge/host handles teardown */ })
    // Hand the leg to the host once the outer connection is up. The inner TLS
    // server buffers until the device's client hello arrives through the relay.
    leg.once(this.#readyEvent, () => { this.#onSession?.(leg) })
    // Keep the pool warm: replace a consumed/closed leg.
    leg.once('close', () => {
      this.#legs.delete(leg)
      this.#waiting.delete(leg)
      this.#fillPool()
    })
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const leg of this.#legs) leg.destroy()
    this.#legs.clear()
    this.#waiting.clear()
  }
}
