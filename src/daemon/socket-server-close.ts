import type { Server, Socket } from 'node:net'


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
