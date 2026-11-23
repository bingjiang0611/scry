import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect } from 'node:tls'
import { once } from 'node:events'
import { cleanupLaneHarness, laneHarness, pairDevice } from './inner-mtls-lanes.fixtures'

afterEach(cleanupLaneHarness)

describe('v3 subscription on a multiplexed inner-mTLS lane', () => {
  it('serves ping while subscribe awaits work and refuses retired pushed streams', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const handle = vi.fn(async () => {
      await gate
      return { mode: 'idle' as const, hostId: 'h', logId: 'l', seq: 1 }
    })
    const { identity, controller, caPEM, addr } = await laneHarness(async () => {}, handle)
    const device = await pairDevice(identity, controller)
    const socket = connect({ port: addr.port, host: addr.host, ca: caPEM, cert: device.certPEM, key: device.keyPEM,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
    await once(socket, 'secureConnect')
    const replies = new Map<number, Record<string, unknown>>()
    let pending = ''
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        expect(line.startsWith('{"keepAlive":true,"id":')).toBe(true)
        const reply = JSON.parse(line) as Record<string, unknown>
        expect(replies.has(reply.id as number)).toBe(false)
        replies.set(reply.id as number, reply)
      }
    })
    const send = (id: number, body: Record<string, unknown>) =>
      socket.write(JSON.stringify({ keepAlive: true, id, protocol: REMOTE_PROTOCOL_VERSION, ...body }) + '\n')
    try {
      send(1, { op: 'subscribe', views: ['activeRuns'], waitMs: 4_000 })
      await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce())
      send(2, { op: 'ping' })
      send(3, { op: 'watchStream', runId: 'run-fixture-1', cursor: 0, outputCursor: 0 })
      send(4, { op: 'cancel', target: 1 })
      send(5, { protocol: 2, op: 'watchStream', runId: 'run-fixture-1', cursor: 0, outputCursor: 0 })
      await vi.waitFor(() => expect(replies.size).toBe(4))
      expect(replies.has(1)).toBe(false)
      expect(replies.get(2)).toHaveProperty('pong')
      for (const id of [3, 4]) expect(replies.get(id)).toMatchObject({ error: 'unknown_op' })
      expect(replies.get(5)).toMatchObject({ error: 'protocol_mismatch', hostProtocol: 3, clientProtocol: 2 })
      release()
      await vi.waitFor(() => expect(replies.get(1)).toMatchObject({ subscribe: { mode: 'idle', seq: 1 } }))
      expect(handle).toHaveBeenCalledOnce()
    } finally { release(); socket.destroy() }
  })

  it('aborts a parked subscription when its authenticated TLS socket closes', async () => {
    let markEntered!: () => void
    let markAborted!: () => void
    const entered = new Promise<void>(resolve => { markEntered = resolve })
    const aborted = new Promise<void>(resolve => { markAborted = resolve })
    const { identity, controller, caPEM, addr } = await laneHarness(async () => {}, async (_peer, _request, signal) => {
      markEntered()
      if (!signal) throw new Error('host did not pass connection cancellation')
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { markAborted(); resolve() }, { once: true }))
      return { mode: 'idle', hostId: 'h', logId: 'l', seq: 1 }
    })
    const device = await pairDevice(identity, controller)
    const socket = connect({ port: addr.port, host: addr.host, ca: caPEM, cert: device.certPEM, key: device.keyPEM,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
    await once(socket, 'secureConnect')
    socket.on('error', () => {})
    try {
      socket.write(JSON.stringify({ keepAlive: true, id: 1, protocol: REMOTE_PROTOCOL_VERSION,
        op: 'subscribe', views: ['activeRuns'], waitMs: 4_000 }) + '\n')
      await entered
      socket.destroy()
      await aborted
    } finally { socket.destroy() }
  })
})
