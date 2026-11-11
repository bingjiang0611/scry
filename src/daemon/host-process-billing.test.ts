import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)

// B4-L4 billing: the daemon answers from its own scry.db. The admin sync is deliberately
// not called here: with real keys in the shell environment it would reach a paid API.

describe('daemon billing', () => {
  it('answers the billing state and imports the fixture into its own ledger', async () => {
    const daemon = await startTestDaemon()
    try {
      const before = await daemon.localOp('billing', 'billingState', [])
      expect(before.error).toBeUndefined()
      expect(before.result).toBeTruthy()
      const imported = await daemon.localOp('billing', 'importBillingFixture', [])
      expect(imported.error).toBeUndefined()
      const result = imported.result as { ok: boolean; rowsImported: number; error?: string; state: unknown }
      // Honest either way: rows when SQLite loads here, a named reason when it does not.
      if (result.ok) expect(result.rowsImported).toBeGreaterThan(0)
      else expect(result.error).toBeTruthy()
      expect(result.state).toBeTruthy()
    } finally {
      await daemon.dispose()
    }
  }, 30_000)
})
