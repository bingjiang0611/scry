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

    const active = gw.submitIntent(CERT, { intentId: randomUUID() })
    ledger.markDispatched(active.runId)

    const settledIds: string[] = []
    for (let i = 0; i < 4_100; i += 1) {
      const sub = gw.submitIntent(CERT, { intentId: randomUUID() })
      ledger.markDispatched(sub.runId)
      ledger.markSettled(sub.runId)
      settledIds.push(sub.runId)
    }

    expect(gw.runMeta(active.runId)).toEqual({ peerCertSHA256: CERT, grantScope: 'local' })
    expect(gw.runScope(active.runId)).toBe('local')

    expect(gw.runMeta(settledIds[0])).toBeUndefined()
    expect(gw.runMeta(settledIds[settledIds.length - 1])).toEqual({ peerCertSHA256: CERT, grantScope: 'local' })
  })
})
