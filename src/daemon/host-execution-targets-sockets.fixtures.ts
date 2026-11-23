import { connect as netConnect } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { REMOTE_PROTOCOL_VERSION } from '../shared/desktop-remote'

export async function openKeepAliveSocket(endpoint: string | number, ca: string, cert: string, key: string) {
  const raw = typeof endpoint === 'number' ? netConnect(endpoint, '127.0.0.1') : netConnect(endpoint)
  await once(raw, 'connect')
  const socket: TLSSocket = tlsConnect({
    socket: raw, ca, cert, key,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined
  })
  await once(socket, 'secureConnect')
  let buffer = ''
  const waiters: Array<(line: string) => void> = []
  const lines: string[] = []
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    while (buffer.includes('\n')) {
      const idx = buffer.indexOf('\n')
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      const waiter = waiters.shift()
      if (waiter) waiter(line)
      else lines.push(line)
    }
  })
  const nextLine = () => lines.length > 0
    ? Promise.resolve(lines.shift()!)
    : new Promise<string>((resolve, reject) => {
      const onEnd = () => reject(new Error('socket_closed'))
      socket.once('close', onEnd)
      waiters.push((line) => { socket.off('close', onEnd); resolve(line) })
    })
  return {
    socket,
    async request(req: Record<string, unknown>) {
      socket.write(`${JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, keepAlive: true, ...req })}\n`)
      return JSON.parse(await nextLine()) as Record<string, any>
    },
    destroy() { socket.destroy() }
  }
}

export async function callTcp(port: number, ca: string, cert: string, key: string, request: Record<string, unknown>) {
  const socket: TLSSocket = tlsConnect({
    host: '127.0.0.1', port, ca, cert, key,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined
  })
  await once(socket, 'secureConnect')
  socket.write(`${JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, ...request })}\n`)
  let buffer = ''
  for await (const chunk of socket) { buffer += (chunk as Buffer).toString('utf8'); if (buffer.includes('\n')) break }
  socket.destroy()
  return JSON.parse(buffer.split('\n')[0]) as Record<string, any>
}
