import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect } from 'node:tls'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { cleanupLaneHarness, laneHarness, pairDevice, routing } from './inner-mtls-lanes.fixtures'

afterEach(cleanupLaneHarness)

describe('InnerMtlsHost pushed run streams', () => {
  it('pushes run output on one stream id until the run settles, and cancels a stream on request', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { identity, controller, caPEM, addr } = await laneHarness(async ({ output }) => {
      output({ kind: 'output', text: 'first words' })
      await gate
    })
    const device = await pairDevice(identity, controller)
    const socket = connect({ port: addr.port, host: addr.host, ca: caPEM, cert: device.certPEM, key: device.keyPEM,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
    await once(socket, 'secureConnect')
    const lines: Record<string, unknown>[] = []
    let pending = ''
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        expect(line.startsWith('{"keepAlive":true,"id":')).toBe(true)
        lines.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
    const send = (value: Record<string, unknown>) => socket.write(JSON.stringify({ keepAlive: true, ...value }) + '\n')
    const byId = (id: number) => lines.filter((line) => line.id === id)
    try {
      send({ id: 1, op: 'submit', intentId: randomUUID(), detail: routing({ prompt: 'stream' }) })
      await vi.waitFor(() => expect(byId(1)).toHaveLength(1))
      const runId = byId(1)[0].runId as string
      send({ id: 2, op: 'watchStream', runId, cursor: 0, outputCursor: 0 })
      await vi.waitFor(() => expect(byId(2).some((line) =>
        JSON.stringify((line.watch as { output: unknown }).output).includes('first words'))).toBe(true), { timeout: 4_000 })
      expect(byId(2).every((line) => line.more === true)).toBe(true)
      // A ping on the same lane is not blocked by the open stream.
      send({ id: 3, op: 'ping' })
      await vi.waitFor(() => expect(byId(3)).toHaveLength(1))
      release()
      await vi.waitFor(() => expect(byId(2).at(-1)?.more).toBe(false), { timeout: 4_000 })
      expect((byId(2).at(-1)!.watch as { state: string }).state).toBe('settled')

      // A second stream on a settled run ends at once; cancel of an unknown id is explicit.
      send({ id: 4, op: 'watchStream', runId, cursor: 0, outputCursor: 0 })
      await vi.waitFor(() => expect(byId(4).at(-1)?.more).toBe(false))
      send({ id: 5, op: 'cancel', target: 4 })
      await vi.waitFor(() => expect(byId(5)).toEqual([{ keepAlive: true, id: 5, cancelled: false }]))
      send({ id: 6, op: 'watchStream', runId, cursor: 'x', outputCursor: 0 })
      await vi.waitFor(() => expect(byId(6)).toEqual([{ keepAlive: true, id: 6, error: 'invalid_request' }]))
    } finally { release(); socket.destroy() }
  })

  it('stops pushing a cancelled stream', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { identity, controller, caPEM, addr } = await laneHarness(async ({ output }) => { output({ kind: 'output', text: 'a' }); await gate })
    const device = await pairDevice(identity, controller)
    const socket = connect({ port: addr.port, host: addr.host, ca: caPEM, cert: device.certPEM, key: device.keyPEM,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
    await once(socket, 'secureConnect')
    const lines: Record<string, unknown>[] = []
    let pending = ''
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        lines.push(JSON.parse(pending.slice(0, end)) as Record<string, unknown>); pending = pending.slice(end + 1)
      }
    })
    const send = (value: Record<string, unknown>) => socket.write(JSON.stringify({ keepAlive: true, ...value }) + '\n')
    try {
      send({ id: 1, op: 'submit', intentId: randomUUID(), detail: routing({ prompt: 'cancel' }) })
      await vi.waitFor(() => expect(lines.some((line) => line.id === 1)).toBe(true))
      const runId = lines.find((line) => line.id === 1)!.runId as string
      send({ id: 2, op: 'watchStream', runId, cursor: 0, outputCursor: 0 })
      await vi.waitFor(() => expect(lines.some((line) => line.id === 2)).toBe(true), { timeout: 4_000 })
      send({ id: 3, op: 'cancel', target: 2 })
      await vi.waitFor(() => expect(lines.find((line) => line.id === 3)).toEqual({ keepAlive: true, id: 3, cancelled: true }))
      const pushed = lines.filter((line) => line.id === 2).length
      release()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(lines.filter((line) => line.id === 2)).toHaveLength(pushed)
    } finally { release(); socket.destroy() }
  })
})
