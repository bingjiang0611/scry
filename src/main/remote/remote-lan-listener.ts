import { createServer, type Server, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'

// Direct route for paired phones on the same network (or an overlay such as
// Tailscale). The bytes on this port are exactly what the relay carries: inner
// TLS 1.3 mTLS to InnerMtlsHost, which requires a CA-issued device certificate
// and re-authorizes every request against the verified peer fingerprint. The
// listener adds reachability, not authority. Unauthenticated peers can only
// attempt TLS handshakes, bounded by the connection cap and handshake timeout.
//
// Addresses are advertised only inside an authorized `ping` reply, never in a
// pairing code or to an unpaired peer.

export interface LanAdvertisement {
  port: number
  addresses: string[]
}

// Fixed default so firewall rules and a phone's remembered route survive a
// restart; an occupied port falls back to an ephemeral one.
export const DEFAULT_REMOTE_LAN_PORT = 47_820
const MAX_CONNECTIONS = 64
const ADVERTISE_CACHE_MS = 10_000

type InterfaceTable = ReturnType<typeof networkInterfaces>

// Private IPv4 (RFC 1918) and the 100.64/10 range overlay VPNs use. Public and
// link-local addresses are never advertised: a phone would only ever reach this
// port from the local network or an overlay.
export function advertisableAddress(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)
}

export function lanAddresses(table: InterfaceTable): string[] {
  const out = new Set<string>()
  for (const entries of Object.values(table)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      if (advertisableAddress(entry.address)) out.add(entry.address)
    }
  }
  // LAN before overlay, deterministic order, bounded.
  return [...out].sort((x, y) => Number(x.startsWith('100.')) - Number(y.startsWith('100.')) || x.localeCompare(y)).slice(0, 4)
}

export class RemoteLanListener {
  #server: Server
  #port: number | null = null
  #interfaces: () => InterfaceTable
  #cached: { at: number; value: LanAdvertisement | undefined } | null = null
  #sockets = new Set<Socket>()

  constructor(serve: (socket: Socket) => void, options: { interfaces?: () => InterfaceTable } = {}) {
    this.#interfaces = options.interfaces ?? networkInterfaces
    this.#server = createServer((socket) => {
      socket.setNoDelay(true)
      // Detect a phone that vanished (Wi-Fi off) without waiting for a write.
      socket.setKeepAlive(true, 30_000)
      socket.on('error', () => socket.destroy())
      this.#sockets.add(socket)
      socket.once('close', () => this.#sockets.delete(socket))
      serve(socket)
    })
    this.#server.maxConnections = MAX_CONNECTIONS
  }

  async listen(port = DEFAULT_REMOTE_LAN_PORT, host = '0.0.0.0'): Promise<number> {
    const bind = (candidate: number) => new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.#server.off('listening', onListening); reject(error) }
      const onListening = () => { this.#server.off('error', onError); resolve() }
      this.#server.once('error', onError)
      this.#server.once('listening', onListening)
      this.#server.listen(candidate, host)
    })
    try { await bind(port) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0) throw error
      await bind(0)
    }
    const address = this.#server.address()
    if (!address || typeof address === 'string') throw new Error('remote_lan_listener_not_listening')
    this.#port = address.port
    return address.port
  }

  // Current addresses for an authorized phone. Cached briefly: a ping must stay
  // cheap, and interfaces change rarely (a network change re-reads them).
  advertisement(now = Date.now()): LanAdvertisement | undefined {
    if (this.#port === null) return undefined
    if (this.#cached && now - this.#cached.at < ADVERTISE_CACHE_MS) return this.#cached.value
    let addresses: string[] = []
    try { addresses = lanAddresses(this.#interfaces()) } catch { addresses = [] }
    const value = addresses.length > 0 ? { port: this.#port, addresses } : undefined
    this.#cached = { at: now, value }
    return value
  }

  async close(): Promise<void> {
    this.#port = null
    this.#cached = null
    if (!this.#server.listening) return
    const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()))
    // server.close() waits for open connections; phones on this route are cut.
    for (const socket of this.#sockets) socket.destroy()
    await closed
  }
}
