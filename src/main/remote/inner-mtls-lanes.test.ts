import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect } from 'node:tls'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { HOST_TRANSPORT_CAPABILITIES, INNER_IDLE_TIMEOUT_MS } from './inner-mtls-host'
import { RemoteLanListener } from './remote-lan-listener'
import { call, cleanupLaneHarness, cleanups, deviceKeyAndCSR, laneHarness, pairDevice } from './inner-mtls-lanes.fixtures'

afterEach(cleanupLaneHarness)

describe('InnerMtlsHost transport lanes (ping, direct route, multiplexing)', () => {
  it('answers a granted device ping with capabilities and refuses ungranted or malformed pings', async () => {
    const { identity, controller, caPEM, addr } = await laneHarness(async () => {})
    const device = await pairDevice(identity, controller)
    const reply = await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'ping', keepAlive: true, deviceLabel: 'iPhone' })
    expect(reply.keepAlive).toBe(true)
    expect(reply.pong.idleTimeoutMs).toBe(INNER_IDLE_TIMEOUT_MS)
    expect(reply.pong.capabilities).toEqual([...HOST_TRANSPORT_CAPABILITIES])
    expect(Math.abs(reply.pong.serverTime - Date.now())).toBeLessThan(5_000)
    expect(await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'ping', extra: 1 })).toEqual({ error: 'invalid_request' })
    const { keyPEM, csrPEM } = await deviceKeyAndCSR()
    const stranger = await identity.issue({ ...(await identity.verifyCSR(csrPEM)), deviceId: randomUUID() })
    expect(await call(addr, caPEM, stranger.certificatePEM, keyPEM, { op: 'ping' })).toEqual({ error: 'device_not_authorized' })
  })

  it('serves the same mTLS over the direct LAN listener and advertises it only in an authorized ping', async () => {
    const { identity, controller, caPEM, host } = await laneHarness(async () => {})
    const device = await pairDevice(identity, controller)
    const listener = new RemoteLanListener((socket) => host.serve(socket), {
      interfaces: () => ({ en0: [{ address: '192.168.4.2', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null } as never] })
    })
    cleanups.push(() => listener.close())
    const port = await listener.listen(0, '127.0.0.1')
    host.setLanAdvertisement(() => listener.advertisement())
    const direct = { port, host: '127.0.0.1' }
    const reply = await call(direct, caPEM, device.certPEM, device.keyPEM, { op: 'ping', keepAlive: true })
    expect(reply.pong.capabilities).toContain('lan')
    expect(reply.pong.lan).toEqual({ port, addresses: ['192.168.4.2'] })
    // Reachability is not authority: an ungranted certificate learns nothing.
    const { keyPEM, csrPEM } = await deviceKeyAndCSR()
    const stranger = await identity.issue({ ...(await identity.verifyCSR(csrPEM)), deviceId: randomUUID() })
    expect(await call(direct, caPEM, stranger.certificatePEM, keyPEM, { op: 'ping' })).toEqual({ error: 'device_not_authorized' })
  })

  it('multiplexes concurrent requests by id on one lane without a long-poll blocking a ping', async () => {
    const { identity, controller, caPEM, addr } = await laneHarness(async () => {})
    const device = await pairDevice(identity, controller)
    const socket = connect({ port: addr.port, host: addr.host, ca: caPEM, cert: device.certPEM, key: device.keyPEM,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
    await once(socket, 'secureConnect')
    const lines: string[] = []
    let pending = ''
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        lines.push(pending.slice(0, end)); pending = pending.slice(end + 1)
      }
    })
    const reply = async (id: number) => {
      await vi.waitFor(() => expect(lines.some((line) => line.startsWith(`{"keepAlive":true,"id":${id},`))).toBe(true), { timeout: 4_000 })
      return JSON.parse(lines.find((line) => line.startsWith(`{"keepAlive":true,"id":${id},`))!) as Record<string, unknown>
    }
    try {
      // Two pipelined requests in one write: the first id switches the lane.
      socket.write(JSON.stringify({ keepAlive: true, id: 1, op: 'ping' }) + '\n' + JSON.stringify({ keepAlive: true, id: 2, op: 'liveRuns', waitMs: 0 }) + '\n')
      expect((await reply(1)).pong).toMatchObject({ capabilities: expect.arrayContaining(['mux']) })
      const revision = ((await reply(2)).liveRuns as { revision: string }).revision
      // A long-poll that will wait, then a ping sent after it: the ping answers first.
      socket.write(JSON.stringify({ keepAlive: true, id: 3, op: 'liveRuns', waitMs: 1_500, revision }) + '\n')
      await new Promise((resolve) => setTimeout(resolve, 50))
      socket.write(JSON.stringify({ keepAlive: true, id: 4, op: 'ping' }) + '\n')
      await reply(4)
      expect(lines.some((line) => line.startsWith('{"keepAlive":true,"id":3,'))).toBe(false)
      expect((await reply(3)).liveRuns).toBeDefined()
      expect(lines.findIndex((line) => line.includes('"id":4,'))).toBeLessThan(lines.findIndex((line) => line.includes('"id":3,')))
      // Once multiplexed, a request without an id ends the lane explicitly.
      const closed = once(socket, 'close')
      socket.write(JSON.stringify({ keepAlive: true, op: 'ping' }) + '\n')
      await closed
      expect(lines.at(-1)).toBe('{"keepAlive":true,"error":"mux_id_required"}')
    } finally { socket.destroy() }
  })
})
