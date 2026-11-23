import { describe, expect, it } from 'vitest'
import { createOpenCodeServerPool } from './opencode-server-pool'

describe('A5: opencode shared server lease reports exclusivity', () => {
  it('is exclusive with one active lease and shared with two', async () => {
    const pool = createOpenCodeServerPool(() => '/nonexistent/opencode')
    try {
      const first = pool.lease('/tmp/ws-a5')
      expect(first).toBeDefined()
      expect(first!.isExclusive()).toBe(true)
      const second = pool.lease('/tmp/ws-a5')
      expect(second).toBeDefined()
      expect(first!.isExclusive()).toBe(false)
      expect(second!.isExclusive()).toBe(false)
      second!.release()
      expect(first!.isExclusive()).toBe(true)
      first!.release()
      // A released lease never claims exclusivity for a force-kill it no longer holds.
      expect(first!.isExclusive()).toBe(false)
    } finally {
      await pool.dispose()
    }
  })

  it('treats a different workspace as a separate server', async () => {
    const pool = createOpenCodeServerPool(() => '/nonexistent/opencode')
    try {
      const a = pool.lease('/tmp/ws-a5-one')
      const b = pool.lease('/tmp/ws-a5-two')
      expect(a!.isExclusive()).toBe(true)
      expect(b!.isExclusive()).toBe(true)
      a!.release()
      b!.release()
    } finally {
      await pool.dispose()
    }
  })
})
