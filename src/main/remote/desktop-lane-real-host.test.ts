import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { RemoteHostService } from './remote-host-service'
import { RunOutputFileStore } from './run-output-file'
import { connectDesktopLane, DesktopLanes, type DesktopLaneChannel, type DesktopLaneEndpoint } from './desktop-lane'
import { verifyCSR } from './enrollment'
import { ProviderOperationGate } from '../provider-operation-gate'
import { setPerformanceRecordingSink, type PerformanceSample } from '../performance-timing'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  setPerformanceRecordingSink(null)
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Real RemoteHostService + InnerMtlsHost on loopback; nothing mocks TLS.
async function pairedLane() {
  const dir = mkdtempSync(join(tmpdir(), 'scry-lane-real-')); dirs.push(dir)
  const service = await RemoteHostService.create({
    stateDirectory: dir, authorizeWorkspace: (cwd: string) => cwd, startRun: async () => {},
    gate: new ProviderOperationGate(), createOutputStore: (directory: string) => new RunOutputFileStore(directory)
  })
  cleanups.push(() => service.dispose())
  const address = await service.host.listen()
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const csrPEM = (await Pkcs10CertificateRequestGenerator.create({ name: 'CN=device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })).toString('pem')
  const { publicKeySHA256 } = await verifyCSR(csrPEM)
  const pair = await service.authority.begin()
  await service.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'Mac' }, publicKeySHA256)
  const grant = await service.authority.confirmLocal(pair.pairingId, publicKeySHA256)
  const endpoint = { host: address.host, port: address.port, caPEM: service.caCertificatePEM, certPEM: grant.certificatePEM, keyPEM: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n` }
  return { service, endpoint, deviceId: grant.deviceId, fingerprint: grant.certificateSHA256 }
}

const hostConnections = (samples: PerformanceSample[]) => samples.filter(sample => sample.name === 'remote.host.connection').length

// The host's liveRuns waits up to 20 s while the revision is unchanged: a real
// in-flight long poll without any test-only host hook.
async function pendingLiveRuns(lanes: DesktopLanes, lane: 'status' | 'bulk', endpoint: DesktopLaneEndpoint, signal?: AbortSignal) {
  const first = await lanes.request(lane, 'c1', { endpoint, request: { op: 'liveRuns', waitMs: 0 }, replayable: true }) as { liveRuns: { revision: string } }
  // Wrapped: an async function would otherwise wait for the whole poll.
  return { pending: lanes.request(lane, 'c1', { endpoint, request: { op: 'liveRuns', waitMs: 20_000, revision: first.liveRuns.revision }, replayable: false, ...(signal ? { signal } : {}) }) }
}

describe('desktop lanes over the real inner-mTLS host', () => {
  it('serves consecutive requests on one verified TLS connection', async () => {
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    const { endpoint } = await pairedLane()
    const lanes = new DesktopLanes()
    cleanups.push(() => lanes.closeAll())
    for (let index = 0; index < 3; index++) {
      await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'providers' }, replayable: true })).resolves.toHaveProperty('providers')
    }
    expect(hostConnections(samples)).toBe(1)
    expect(samples.filter(sample => sample.name === 'remote.host.request')).toHaveLength(3)
    expect(samples.filter(sample => sample.name === 'remote.client.request').map(sample => sample.counters?.reused)).toEqual([0, 1, 1])
  })

  it('closes a revoked device\u2019s kept-alive tunnel', async () => {
    const { service, endpoint, deviceId } = await pairedLane()
    const channel = await connectDesktopLane(endpoint)
    cleanups.push(() => channel.destroy())
    await channel.send(`${JSON.stringify({ keepAlive: true, op: 'providers' })}\n`)
    expect(await channel.receive()).toMatch(/^\{"keepAlive":true,/)
    const closed = new Promise<Error>(resolve => { channel.onClose(resolve) })
    await service.revokeDevice(deviceId)
    // Closed by the host on revocation, not by the 30 s idle timeout.
    await expect(closed).resolves.toBeInstanceOf(Error)
  })

  it('reconnects after the host drops an idle tunnel', async () => {
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    const { service, endpoint, fingerprint } = await pairedLane()
    let opened: DesktopLaneChannel | undefined
    const lanes = new DesktopLanes(async target => { opened = await connectDesktopLane(target); return opened })
    cleanups.push(() => lanes.closeAll())
    await lanes.request('control', 'c1', { endpoint, request: { op: 'providers' }, replayable: true })
    const dropped = new Promise<void>(resolve => { opened!.onClose(() => resolve()) })
    // The same host-side destroy the 30 s idle timeout performs.
    service.host.closePeer(fingerprint)
    await dropped
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'providers' }, replayable: true })).resolves.toHaveProperty('providers')
    expect(hostConnections(samples)).toBe(2)
  })

  it('re-sends a request whose channel never opened', async () => {
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    const { endpoint } = await pairedLane()
    let attempts = 0
    const lanes = new DesktopLanes(async target => {
      if (attempts++ === 0) throw new Error('tunnel_not_ready')
      return await connectDesktopLane(target)
    })
    cleanups.push(() => lanes.closeAll())
    // Not sent: even a non-replayable request may go out on the new channel.
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'providers' }, replayable: false })).resolves.toHaveProperty('providers')
    expect(attempts).toBe(2)
    expect(samples.filter(sample => sample.name === 'remote.host.request')).toHaveLength(1)
  })

  it('cancels a pending bulk read without disturbing control', async () => {
    const { endpoint } = await pairedLane()
    const lanes = new DesktopLanes()
    cleanups.push(() => lanes.closeAll())
    const controller = new AbortController()
    const bulk = await pendingLiveRuns(lanes, 'bulk', endpoint, controller.signal)
    const outcome = expect(bulk.pending).rejects.toThrow('desktop_lane_cancelled')
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'providers' }, replayable: true })).resolves.toHaveProperty('providers')
    controller.abort()
    await outcome
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'providers' }, replayable: true })).resolves.toHaveProperty('providers')
  })

  it('fails an in-flight long poll on revocation and rejects later requests', async () => {
    const { service, endpoint, deviceId } = await pairedLane()
    const lanes = new DesktopLanes()
    cleanups.push(() => lanes.closeAll())
    const poll = await pendingLiveRuns(lanes, 'status', endpoint)
    const outcome = expect(poll.pending).rejects.toThrow()
    const started = Date.now()
    await service.revokeDevice(deviceId)
    await outcome
    // Closed by revocation, far below the 20 s long-poll window.
    expect(Date.now() - started).toBeLessThan(5_000)
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'providers' }, replayable: true })).resolves.toEqual({ error: 'device_not_authorized' })
  })
})
