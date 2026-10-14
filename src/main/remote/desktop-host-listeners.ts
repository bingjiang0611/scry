import { createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export interface DesktopHostEndpoint {
  serve(stream: Duplex): void
}

export interface DesktopHostListenersOptions {
  pair: DesktopHostEndpoint
  run: DesktopHostEndpoint
  maxConnectionsPerEndpoint?: number
  connectionTimeoutMs?: number
  pairPort?: number
  runPort?: number
}

export interface DesktopHostListenerPorts {
  pairPort: number
  runPort: number
}

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_MAX_CONNECTIONS = 32
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000

type EndpointName = 'pair' | 'run'

export class DesktopHostListeners {
  readonly #endpoints: Record<EndpointName, DesktopHostEndpoint>
  readonly #servers: Record<EndpointName, Server>
  readonly #sockets: Record<EndpointName, Set<Socket>> = {
    pair: new Set(),
    run: new Set()
  }
  readonly #maxConnections: number
  readonly #connectionTimeoutMs: number
  readonly #requestedPorts: Record<EndpointName, number>
  #ports: DesktopHostListenerPorts | undefined
  #accepting = true
  #startPromise: Promise<DesktopHostListenerPorts> | undefined
  #closePromise: Promise<void> | undefined
  #disposed = false

  constructor(options: DesktopHostListenersOptions) {
    this.#endpoints = { pair: options.pair, run: options.run }
    this.#maxConnections = options.maxConnectionsPerEndpoint ?? DEFAULT_MAX_CONNECTIONS
    this.#connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS
    this.#requestedPorts = { pair: options.pairPort ?? 0, run: options.runPort ?? 0 }
    for (const port of Object.values(this.#requestedPorts)) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_desktop_listener_port')
    }
    if (!Number.isInteger(this.#maxConnections) || this.#maxConnections < 1) throw new Error('invalid_max_connections')
    if (!Number.isInteger(this.#connectionTimeoutMs) || this.#connectionTimeoutMs < 1) throw new Error('invalid_connection_timeout')
    this.#servers = {
      pair: this.#createServer('pair'),
      run: this.#createServer('run')
    }
  }

  async start(): Promise<DesktopHostListenerPorts> {
    if (this.#disposed) throw new Error('desktop_host_listeners_disposed')
    if (this.#ports) return this.#ports
    if (this.#startPromise) return this.#startPromise
    const pending = this.#start()
    this.#startPromise = pending
    try {
      return await pending
    } finally {
      if (this.#startPromise === pending) this.#startPromise = undefined
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#disposed = true
    const pendingStart = this.#startPromise
    this.#closePromise = (async () => {
      if (pendingStart) {
        try { await pendingStart } catch { /* startup performs its own rollback */ }
      }
      await this.#closeOwnedResources()
      this.#ports = undefined
    })()
    return this.#closePromise
  }

  dispose(): Promise<void> {
    return this.close()
  }

  async #start(): Promise<DesktopHostListenerPorts> {
    this.#accepting = true
    try {
      const pairPort = await this.#listen(this.#servers.pair, this.#requestedPorts.pair)
      if (this.#disposed) throw new Error('desktop_host_listeners_disposed')
      const runPort = await this.#listen(this.#servers.run, this.#requestedPorts.run)
      if (this.#disposed) throw new Error('desktop_host_listeners_disposed')
      const ports = { pairPort, runPort }
      this.#ports = ports
      return ports
    } catch (error) {
      await this.#closeOwnedResources()
      throw error
    }
  }

  #createServer(endpoint: EndpointName): Server {
    return createServer((socket) => {
      if (!this.#accepting) {
        socket.destroy()
        return
      }
      const sockets = this.#sockets[endpoint]
      if (sockets.size >= this.#maxConnections) {
        socket.destroy()
        return
      }
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', () => {})
      // This covers the TLS handshake and remains a bounded idle lifetime for
      // transports that do not install their own application timeout. InnerMtlsHost
      // replaces it after TLS setup while dispatching, then arms its own idle timer.
      socket.setTimeout(this.#connectionTimeoutMs, () => socket.destroy())
      try {
        this.#endpoints[endpoint].serve(socket)
      } catch {
        socket.destroy()
      }
    })
  }

  #listen(server: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('error', onError)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('desktop_host_listener_address_unavailable'))
          return
        }
        resolve(address.port)
      }
      server.once('error', onError)
      server.listen({ host: LOOPBACK_HOST, port }, onListening)
    })
  }

  async #closeOwnedResources(): Promise<void> {
    this.#accepting = false
    const sockets = [...this.#sockets.pair, ...this.#sockets.run]
    await Promise.all(sockets.map((socket) => this.#destroySocket(socket)))
    await Promise.all([this.#closeServer(this.#servers.pair), this.#closeServer(this.#servers.run)])
  }

  async #destroySocket(socket: Socket): Promise<void> {
    if (socket.destroyed) return
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.destroy()
    })
  }

  async #closeServer(server: Server): Promise<void> {
    if (!server.listening) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
