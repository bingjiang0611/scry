import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)


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
      if (result.ok) expect(result.rowsImported).toBeGreaterThan(0)
      else expect(result.error).toBeTruthy()
      expect(result.state).toBeTruthy()
    } finally {
      await daemon.dispose()
    }
  }, 30_000)
})
