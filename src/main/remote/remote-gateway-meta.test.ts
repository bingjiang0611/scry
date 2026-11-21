import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { RemoteGateway } from './remote-gateway'
import { SessionLedger, type LedgerEvent, type LedgerStore } from './session-ledger'

const CERT = 'a'.repeat(64)

function memoryLedgerStore(): LedgerStore {
  const events: LedgerEvent[] = []
  return {
    assertAvailable: () => undefined,
    loadAll: () => [...events],
    append: (event) => {
      events.push(event)
    },
    compact: () => {
      events.length = 0
    }
  }
}

describe('RemoteGateway runMeta bounded eviction', () => {
  it('evicts terminal runs above 4096 while preserving active runs in #runMeta', () => {
    const ledger = new SessionLedger({ store: memoryLedgerStore() })
    const gw = new RemoteGateway({
      authority: {
        authorizesCertificate: (fp) => fp === CERT,
        grantScope: () => 'local'
      },
      ledger
    })

    // 1. Submit 1 active (dispatched) run first — oldest entry in Map
    const active = gw.submitIntent(CERT, { intentId: randomUUID() })
    ledger.markDispatched(active.runId)

    // 2. Submit and settle 4,100 subsequent runs -> exceeds MAX_TRACKED_RUN_META (4096)
    const settledIds: string[] = []
    for (let i = 0; i < 4_100; i += 1) {
      const sub = gw.submitIntent(CERT, { intentId: randomUUID() })
      ledger.markDispatched(sub.runId)
      ledger.markSettled(sub.runId)
      settledIds.push(sub.runId)
    }

    // Active run MUST still be retained even though it was the oldest entry
    expect(gw.runMeta(active.runId)).toEqual({ peerCertSHA256: CERT, grantScope: 'local' })
    expect(gw.runScope(active.runId)).toBe('local')

    // Earliest settled runs MUST have been evicted to stay within the 4,096 cap
    expect(gw.runMeta(settledIds[0])).toBeUndefined()
    expect(gw.runMeta(settledIds[settledIds.length - 1])).toEqual({ peerCertSHA256: CERT, grantScope: 'local' })
  })
})
