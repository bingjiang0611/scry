import type { Server, Socket } from 'node:net'

// Closing a daemon socket server. `server.close()` only stops accepting: its callback
// waits for every open connection to end. The App keeps its connections open for as
// long as the daemon runs (lanes, a parked event poll), and during a restart or a quit
// the App is waiting for the daemon to exit, so waiting for the App to hang up first
// deadlocked both (S0-1 macOS verification: 15 s timeouts; the daemon exited ~120 ms
// after the App was killed). Requests already in flight get a short grace; then every
// connection that is still open is destroyed. The App treats a dropped connection as an
// unknown outcome and only replays what is declared replayable.

export const CLOSE_GRACE_MS = 500

export interface TrackedServer {
  server: Server
  close(graceMs?: number): Promise<void>
}

export function trackConnections(server: Server): TrackedServer {
  const open = new Set<Socket>()
  server.on('connection', (socket: Socket) => {
    open.add(socket)
    socket.once('close', () => { open.delete(socket) })
  })
  let closing: Promise<void> | undefined
  return {
    server,
    close(graceMs = CLOSE_GRACE_MS) {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve())
        if (open.size === 0) return
        const timer = setTimeout(() => { for (const socket of open) socket.destroy() }, graceMs)
        timer.unref?.()
        server.once('close', () => clearTimeout(timer))
      })
      return closing
    }
  }
}
