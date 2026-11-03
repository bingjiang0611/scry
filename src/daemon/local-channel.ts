import { createServer, type Server } from 'node:net'
import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

// The daemon's local channel: the same inner-mTLS host, reached through a unix
// socket instead of TCP. A unix socket cannot be reachable from another machine,
// so the daemon exposes no port at all.
//
// Trust comes from two independent checks:
//   - the socket lives in a 0700 directory and is itself 0600, so only this user
//     can connect at all (there is no peer-credential API in Node; the file mode
//     and owner are the local-uid check);
//   - the connection still has to complete the host's mTLS handshake with a
//     device certificate the host issued and has not revoked.
export interface LocalChannelOptions {
  // Directory that holds the socket. Created 0700 and never widened.
  directory: string
  // Serves one accepted byte stream. InnerMtlsHost.serve() is the production
  // implementation; tests pass a byte echo to check framing only.
  serve(stream: Duplex): void
}

export interface LocalChannel {
  socketPath: string
  close(): Promise<void>
}

export const LOCAL_SOCKET_NAME = 'local.sock'

// Unix socket paths are limited to 104 bytes on macOS; the caller owns the choice
// of `directory`, so a path that is too long fails loudly instead of binding
// somewhere unexpected.
const MAX_SOCKET_PATH = 100

export async function openLocalChannel(options: LocalChannelOptions): Promise<LocalChannel> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  chmodSync(options.directory, 0o700)
  const socketPath = join(options.directory, LOCAL_SOCKET_NAME)
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) throw new Error('daemon_socket_path_too_long')
  // A stale socket from a crashed daemon would make listen() fail with EADDRINUSE.
  rmSync(socketPath, { force: true })
  const server: Server = createServer((stream) => { options.serve(stream) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { server.off('error', reject); resolve() })
  })
  // Bind first, then narrow: the window where another user could connect is the
  // time between listen() and chmod(), and the directory is already 0700.
  chmodSync(socketPath, 0o600)
  const mode = statSync(socketPath).mode & 0o777
  if (mode !== 0o600) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error(`daemon_socket_mode_${mode.toString(8)}`)
  }
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(socketPath, { force: true })
    }
  }
}

// No TCP listener exists by construction: the only handle is the unix socket.
// Reported so a caller can assert it rather than assume it.
export function listeningAddresses(server: Server): string[] {
  const address = server.address()
  if (!address) return []
  return [typeof address === 'string' ? address : `${address.address}:${address.port}`]
}
