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

export interface RelayDiagnostics {
  // These are transport-observed states, not relay-side admissions. They are
  // disjoint: an outer leg is opening, waiting for a device, or carrying one.
  waiting: number
  active: number
  opening: number
  limit: number
}

export interface RelayTransport {
  // Begin producing device session streams. Each emitted duplex is one device's
  // outer leg; the caller runs inner mTLS over it. Errors that are not fatal to
  // the tunnel are reported but must not tear down the host.
  start(onSession: (stream: Duplex) => void, onError?: (error: Error) => void): Promise<void>
  // Optional because private/test transports may not expose pool state.
  diagnostics?(): RelayDiagnostics
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

  diagnostics(): RelayDiagnostics | undefined {
    return this.#transport.diagnostics?.()
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
  #limit: number
  #readyEvent: string
  #idleLegMs?: number
  #closed = false
  #legs = new Set<OutboundLeg>()
  #opening = new Set<OutboundLeg>()
  #waiting = new Set<OutboundLeg>()
  #active = new Set<OutboundLeg>()
  #onSession: ((stream: Duplex) => void) | null = null

  // readyEvent is the event that signals the outer leg is up and safe to serve
  // inner mTLS over: 'connect' for a plain TCP leg, 'secureConnect' for an outer
  // TLS leg (TLS-in-TLS: inner mTLS runs inside the host<->relay outer TLS).
  // idleLegMs replaces a waiting leg that stayed unused that long. A silently
  // dead outer connection (NAT/proxy idle drop, sleep, network change) can still
  // look open at the relay, which then glues a device to it and the device's
  // inner handshake times out. Recycling bounds how stale a waiting leg can be;
  // a device that races a recycle sees a close before any inner byte and may
  // safely reconnect.
  constructor(deps: { connect: () => OutboundLeg; poolSize?: number; readyEvent?: string; idleLegMs?: number }) {
    this.#connect = deps.connect
    this.#poolSize = Math.max(1, deps.poolSize ?? 2)
    this.#limit = this.#poolSize * 4
    this.#readyEvent = deps.readyEvent ?? 'connect'
    this.#idleLegMs = deps.idleLegMs
  }

  diagnostics(): RelayDiagnostics {
    return { waiting: this.#waiting.size, active: this.#active.size, opening: this.#opening.size, limit: this.#limit }
  }

  async start(onSession: (stream: Duplex) => void): Promise<void> {
    if (this.#onSession) throw new Error('reverse_tunnel_already_started')
    this.#onSession = onSession
    this.#fillPool()
  }

  #fillPool(): void {
    // Keep idle reserve separate from active transfers. Opening legs count
    // toward the reserve, so a slow relay cannot cause an opening burst up to
    // the total limit. At the limit there may be no idle reserve; that is a
    // measurable capacity condition, not a reason to raise the pool.
    while (!this.#closed && this.#waiting.size + this.#opening.size < this.#poolSize && this.#legs.size < this.#limit) this.#spawn()
  }

  #spawn(): void {
    if (this.#closed || !this.#onSession) return
    const leg = this.#connect()
    this.#legs.add(leg)
    this.#opening.add(leg)
    leg.once('relaySession', () => {
      this.#opening.delete(leg)
      this.#waiting.delete(leg)
      this.#active.add(leg)
      this.#fillPool()
    })
    leg.on('error', () => { /* the bridge/host handles teardown */ })
    if (this.#idleLegMs !== undefined) {
      const recycle = setTimeout(() => { if (this.#waiting.has(leg) || this.#opening.has(leg)) leg.destroy() }, this.#idleLegMs)
      recycle.unref?.()
      leg.once('relaySession', () => clearTimeout(recycle))
      leg.once('close', () => clearTimeout(recycle))
    }
    // WSS outer-connect and inner-server readiness are separate: relaySession
    // starts inner TLS only after device bytes arrive, not while the leg waits.
    const outerReady = this.#readyEvent === 'relaySession' ? 'connect' : this.#readyEvent
    leg.once(outerReady, () => {
      this.#opening.delete(leg)
      if (!this.#active.has(leg)) this.#waiting.add(leg)
    })
    leg.once(this.#readyEvent, () => { this.#onSession?.(leg) })
    // Keep the pool warm: replace a consumed/closed leg.
    leg.once('close', () => {
      this.#legs.delete(leg)
      this.#opening.delete(leg)
      this.#waiting.delete(leg)
      this.#active.delete(leg)
      this.#fillPool()
    })
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const leg of this.#legs) leg.destroy()
    this.#legs.clear()
    this.#opening.clear()
    this.#waiting.clear()
    this.#active.clear()
  }
}
