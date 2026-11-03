import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { RemoteHostService } from './remote-host-service'
import { setup, ssh } from './desktop-client-fixtures'
import { RunOutputFileStore } from './run-output-file'
import { DesktopLanes } from './desktop-lane'
import { verifyCSR } from './enrollment'
import { ProviderOperationGate } from '../provider-operation-gate'
import { setPerformanceRecordingSink } from '../performance-timing'
import type { PerformanceSample } from '../performance-timing'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  setPerformanceRecordingSink(null)
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Real host, real mTLS, real lanes: the claim under test is how many requests a
// device sends while nothing happens, so a mocked transport would not test it.
async function pairedHost() {
  const dir = mkdtempSync(join(tmpdir(), 'scry-longpoll-')); dirs.push(dir)
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
  await service.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'Desktop' }, publicKeySHA256)
  const grant = await service.authority.confirmLocal(pair.pairingId, publicKeySHA256)
  const lanes = new DesktopLanes()
  cleanups.push(() => lanes.closeAll())
  return {
    service,
    lanes,
    endpoint: {
      host: address.host, port: address.port, caPEM: service.caCertificatePEM,
      certPEM: grant.certificatePEM, keyPEM: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`
    },
    fingerprint: grant.certificateSHA256
  }
}

describe('long polling instead of ticking', () => {
  it('costs one request per window, so an idle minute stays under six', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Idle', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const runId = '22222222-2222-4222-8222-222222222222'
      const before = fixture.tlsRequest.mock.calls.length
      // First read answers now, so a caller that has never seen the run is not made
      // to wait a window for an answer it already has.
      await fixture.client.runStatus(id, runId)
      const first = fixture.tlsRequest.mock.calls.slice(before).map(call => (call[0].request as { op?: string; waitMs?: number }))
      expect(first).toHaveLength(1)
      expect(first[0]).toMatchObject({ op: 'watch', waitMs: 0, output: false })
      const beforeSecond = fixture.tlsRequest.mock.calls.length
      await fixture.client.runStatus(id, runId)
      const second = fixture.tlsRequest.mock.calls.slice(beforeSecond).map(call => (call[0].request as { op?: string; waitMs?: number }))
      // Later reads wait on the host: one request per window, not one per second.
      expect(second).toHaveLength(1)
      expect(second[0]).toMatchObject({ op: 'watch', output: false })
      expect(Number(second[0].waitMs)).toBeGreaterThanOrEqual(15_000)
      // Four windows a minute, below the six-request budget with room for a retry.
      expect(Math.ceil(60_000 / Number(second[0].waitMs)) + 2).toBeLessThanOrEqual(6)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('answers at once for a device that has not seen the set, then waits for a change', async () => {
    const { lanes, endpoint } = await pairedHost()
    const first = await lanes.request('status', 'c1', { endpoint, request: { op: 'liveRuns', waitMs: 0 }, replayable: true }) as { liveRuns: { revision: string; runs: unknown[] } }
    expect(first.liveRuns.runs).toEqual([])
    // Same revision: the host holds the request instead of answering immediately.
    const started = Date.now()
    const held = lanes.request('status', 'c1', { endpoint, request: { op: 'liveRuns', waitMs: 400, revision: first.liveRuns.revision }, replayable: false })
    const second = await held as { liveRuns: { revision: string } }
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(second.liveRuns.revision).toBe(first.liveRuns.revision)
  })

  it('refuses a lifecycle watch for an unknown run without returning output', async () => {
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    const { lanes, endpoint } = await pairedHost()
    const response = await lanes.request('watch', 'c1', { endpoint, request: { op: 'watch', runId: '11111111-1111-4111-8111-111111111111', cursor: 0, outputCursor: 0, waitMs: 0, output: false }, replayable: true })
    // Lifecycle only: the reply never carries an output page, so an output-cache
    // fault cannot appear here at all.
    expect(response).toEqual({ error: 'unknown_run' })
    expect(JSON.stringify(samples)).not.toContain('11111111')
  })
})
