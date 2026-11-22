import { createServer, type Server } from 'node:net'
import { trackConnections } from './socket-server-close'
import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

export interface LocalChannelOptions {
  directory: string
  serve(stream: Duplex): void
}

export interface LocalChannel {
  socketPath: string
  close(): Promise<void>
}

export const LOCAL_SOCKET_NAME = 'local.sock'

const MAX_SOCKET_PATH = 100

export async function openLocalChannel(options: LocalChannelOptions): Promise<LocalChannel> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  chmodSync(options.directory, 0o700)
  const socketPath = join(options.directory, LOCAL_SOCKET_NAME)
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) throw new Error('daemon_socket_path_too_long')
  rmSync(socketPath, { force: true })
  const server: Server = createServer((stream) => { options.serve(stream) })
  const tracked = trackConnections(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { server.off('error', reject); resolve() })
  })
  chmodSync(socketPath, 0o600)
  const mode = statSync(socketPath).mode & 0o777
  if (mode !== 0o600) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error(`daemon_socket_mode_${mode.toString(8)}`)
  }
  return {
    socketPath,
    close: async () => {
      const closing = tracked.close()
      rmSync(socketPath, { force: true })
      await closing
    }
  }
}

export function listeningAddresses(server: Server): string[] {
  const address = server.address()
  if (!address) return []
  return [typeof address === 'string' ? address : `${address.address}:${address.port}`]
}
