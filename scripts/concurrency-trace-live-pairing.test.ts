import { beforeAll, describe, expect, it } from 'vitest'
import { parsePairPayload, parsePeerPayload } from './fixtures/concurrency-trace-live-commands'

interface PairPayloadShape { peerId: number; label: string; invitation: string; directory: string }
interface PeerRecord {
  peerIndex: number
  peerId: number
  label: string
  status: string
  connectionId?: string
  invitation?: { pairingId: string }
  rendererPid?: number | null
  window?: { driverInstalled: boolean }
  setupCounters?: unknown
}
interface PairingModule {
  peerIdentity(index: number): { peerId: number; label: string; directoryName: string }
  pairAllPeers(input: Record<string, unknown>): Promise<{ connections: string[]; renderers: Array<number | null>; peers: PeerRecord[] }>
}

let pairing: PairingModule
beforeAll(async () => {
  pairing = await import(new URL('./fixtures/concurrency-trace-live-pairing.mjs', import.meta.url).href) as PairingModule
})

const STATE_ROOT = '/tmp/concurrency-trace-live/client-state'

function harness(overrides: { finish?: unknown; window?: unknown; confirmation?: unknown } = {}) {
  const pairCalls: PairPayloadShape[] = []
  const finishCalls: number[] = []
  const windowCalls: number[] = []
  const countersCalls: number[] = []
  const countersResults: Array<Record<string, unknown>> = []
  const events: string[] = []
  const confirms: Array<{ pairingId: string; sha: string }> = []
  const invitationIds: string[] = []
  const report = { peers: [] as PeerRecord[] }
  const client = {
    stateRoot: STATE_ROOT,
    pair: async (payload: unknown) => {
      // The real validator is the contract: a string peer id cannot pass.
      const parsed = parsePairPayload(payload as Record<string, unknown>)
      pairCalls.push(parsed)
      events.push(`pair:${parsed.peerId}`)
      return { peerId: parsed.peerId, connectionId: `conn-${parsed.peerId}`, publicKeySHA256: `sha-${parsed.peerId}`, state: 'pending', pairingId: 'pair-1', hostId: 'host-1' }
    },
    finish: async (peerId: unknown) => {
      const parsed = parsePeerPayload({ peerId })
      finishCalls.push(parsed.peerId)
      events.push(`finish:${parsed.peerId}`)
      return overrides.finish ?? { peerId: parsed.peerId, connectionId: `conn-${parsed.peerId}`, state: 'paired' }
    },
    openWindow: async (peerId: unknown) => {
      const parsed = parsePeerPayload({ peerId })
      windowCalls.push(parsed.peerId)
      events.push(`window:${parsed.peerId}`)
      return overrides.window ?? { webContentsId: parsed.peerId + 10, rendererPid: 9000 + parsed.peerId, driverInstalled: true, url: 'file:///fixture/index.html' }
    },
    counters: async (peerId: unknown) => {
      const parsed = parsePeerPayload({ peerId })
      countersCalls.push(parsed.peerId)
      events.push(`counters:${parsed.peerId}`)
      // Stand-in for runCommand('counters'): the real reply is reset on read, so the wiring
      // below is what the test proves, not these numbers.
      const result = { attempts: { catalog: 1 }, tls: { pairRequests: 2, tunnelOpens: 3, runRequests: 22 } }
      countersResults.push(result)
      return result
    }
  }
  const host = {
    invite: async () => {
      const index = invitationIds.length + 1
      const pairingId = `pair-${index}`
      invitationIds.push(pairingId)
      return { invitation: `scry-desktop1:invite-${index}`, pairingId, hostId: 'host-1', pairPort: 2000 + index, runPort: 3000 + index, expiresAt: Date.now() + 60_000 }
    },
    confirmPairing: async (pairingId: string, sha: string) => {
      confirms.push({ pairingId, sha })
      events.push(`confirm:${pairingId}`)
      return overrides.confirmation ?? { revoked: false }
    }
  }
  return { client, host, report, pairCalls, finishCalls, windowCalls, countersCalls, countersResults, events, confirms, invitationIds }
}

describe('live lane peer pairing wiring', () => {
  it('pairs every peer with an integer id, its own invitation and the real reply shapes', async () => {
    const fake = harness()
    const result = await pairing.pairAllPeers({ count: 4, client: fake.client, host: fake.host, stateRoot: STATE_ROOT, report: fake.report })

    // Peer ids are integers: labels and directories may be strings.
    expect(fake.pairCalls.map((call) => call.peerId)).toEqual([0, 1, 2, 3])
    expect(fake.pairCalls.map((call) => call.label)).toEqual(['peer-0', 'peer-1', 'peer-2', 'peer-3'])
    expect(fake.pairCalls.map((call) => call.directory)).toEqual([
      `${STATE_ROOT}/peer-0`, `${STATE_ROOT}/peer-1`, `${STATE_ROOT}/peer-2`, `${STATE_ROOT}/peer-3`
    ])
    expect(fake.pairCalls.every((call) => typeof call.peerId === 'number')).toBe(true)

    // One real invitation per peer, and each grant uses that peer's own pairing id.
    expect(fake.invitationIds).toHaveLength(4)
    expect(new Set(fake.invitationIds).size).toBe(4)
    expect(fake.confirms).toEqual([
      { pairingId: 'pair-1', sha: 'sha-0' }, { pairingId: 'pair-2', sha: 'sha-1' },
      { pairingId: 'pair-3', sha: 'sha-2' }, { pairingId: 'pair-4', sha: 'sha-3' }
    ])

    // Finish and window take the integer id too, and the window must have installed the driver.
    expect(fake.finishCalls).toEqual([0, 1, 2, 3])
    expect(fake.windowCalls).toEqual([0, 1, 2, 3])
    expect(result.connections).toEqual(['conn-0', 'conn-1', 'conn-2', 'conn-3'])
    expect(result.renderers).toEqual([9000, 9001, 9002, 9003])
    expect(fake.report.peers.map((peer) => peer.status)).toEqual(['ready', 'ready', 'ready', 'ready'])
    expect(fake.report.peers[0]).toMatchObject({ peerIndex: 0, peerId: 0, label: 'peer-0', connectionId: 'conn-0' })
  })

  it('reads the setup counters once per peer, after pairing and the window mount', async () => {
    // The client counters are reset on read: this single read per peer keeps pairing/handshake
    // traffic out of the first measured visit without dropping it from the report.
    const fake = harness()
    await pairing.pairAllPeers({ count: 2, client: fake.client, host: fake.host, stateRoot: STATE_ROOT, report: fake.report })
    expect(fake.countersCalls).toEqual([0, 1])
    expect(fake.events).toEqual([
      'pair:0', 'confirm:pair-1', 'finish:0', 'window:0', 'counters:0',
      'pair:1', 'confirm:pair-2', 'finish:1', 'window:1', 'counters:1'
    ])
    // The stored value is exactly the reply the client gave for that peer, never synthesized.
    expect(fake.report.peers.every((peer) => peer.setupCounters === fake.countersResults[peer.peerIndex])).toBe(true)
    expect(fake.report.peers[0].setupCounters).toMatchObject({ tls: { pairRequests: 2, tunnelOpens: 3, runRequests: 22 } })
  })

  it('documents why ids must stay integers: the real validators reject the label form', () => {
    // This is the caller bug this test guards: `peer-${i}` is a label, never an id.
    expect(() => parsePairPayload({ peerId: 'peer-0', label: 'peer-0', invitation: 'scry-desktop1:x', directory: `${STATE_ROOT}/peer-0` })).toThrow(/invalid_peer/)
    expect(() => parsePeerPayload({ peerId: 'peer-0' })).toThrow(/invalid_peer/)
    expect(parsePairPayload({ peerId: 0, label: 'peer-0', invitation: 'scry-desktop1:x', directory: `${STATE_ROOT}/peer-0` })).toMatchObject({ peerId: 0 })
  })

  it('refuses a finish reply that does not carry state=paired', async () => {
    // runCommand answers `{peerId, connectionId, state}`; a caller reading `status` never sees
    // 'paired' and must not proceed to a window.
    const fake = harness({ finish: { peerId: 0, connectionId: 'conn-0', status: 'paired' } })
    await expect(pairing.pairAllPeers({ count: 1, client: fake.client, host: fake.host, stateRoot: STATE_ROOT, report: fake.report }))
      .rejects.toThrow(/did not finish pairing/)
    expect(fake.windowCalls).toEqual([])
    // Nothing was read, so a failed peer does not silently consume the setup counters.
    expect(fake.countersCalls).toEqual([])
    expect(fake.report.peers[0].status).toBe('pending')
  })

  it('refuses a window whose fixture driver did not install', async () => {
    const fake = harness({ window: { webContentsId: 10, rendererPid: 9000, driverInstalled: false, url: 'file:///fixture/index.html' } })
    await expect(pairing.pairAllPeers({ count: 1, client: fake.client, host: fake.host, stateRoot: STATE_ROOT, report: fake.report }))
      .rejects.toThrow(/did not install the fixture driver/)
    expect(fake.report.peers[0].status).toBe('pending')
  })

  it('refuses a pairing the host did not grant', async () => {
    const fake = harness({ confirmation: { revoked: true } })
    await expect(pairing.pairAllPeers({ count: 1, client: fake.client, host: fake.host, stateRoot: STATE_ROOT, report: fake.report }))
      .rejects.toThrow(/was not granted/)
    expect(fake.finishCalls).toEqual([])
  })

  it('keeps the peer identity contract in one place', () => {
    expect(pairing.peerIdentity(3)).toEqual({ peerId: 3, label: 'peer-3', directoryName: 'peer-3' })
    expect(() => pairing.peerIdentity(-1)).toThrow(/non-negative integer/)
  })
})
