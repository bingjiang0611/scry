import { describe, expect, it, vi } from 'vitest'
import { RotomRpcPool } from './pi-rpc'

// C1: a kept Pi process is a session the host records. The pool already reused by key, released on
// idle and evicted oldest-first; those moments must be observable so a release reason can be read
// back instead of inferred from a log line.

const profile = { id: 'p1', executable: '/bin/pi' } as never

function fakeRpc(close = vi.fn(async () => {})) {
  return { reusable: () => true, close } as never
}

describe('Pi RPC pool lifecycle observation', () => {
  it('reports a kept process and its idle release', async () => {
    vi.useFakeTimers()
    try {
      const released: Array<{ sessionId: string; reason: string }> = []
      const pool = new RotomRpcPool({ idleMs: 15 * 60_000, onReleased: (sessionId, reason) => released.push({ sessionId, reason }) })
      pool.keep(profile, '/w', 'sess-1', fakeRpc(), {})
      vi.advanceTimersByTime(15 * 60_000 + 1)
      expect(released).toEqual([{ sessionId: 'sess-1', reason: 'idle' }])
    } finally { vi.useRealTimers() }
  })

  it('reports an eviction when the pool is over its cap', () => {
    const released: Array<{ sessionId: string; reason: string }> = []
    const pool = new RotomRpcPool({ maxIdle: 1, onReleased: (sessionId, reason) => released.push({ sessionId, reason }) })
    pool.keep(profile, '/w', 'sess-1', fakeRpc(), {})
    pool.keep(profile, '/w', 'sess-2', fakeRpc(), {})
    expect(released).toEqual([{ sessionId: 'sess-1', reason: 'evicted' }])
    expect(pool.size).toBe(1)
  })

  it('reports a replacement and a shutdown release', async () => {
    const released: Array<{ sessionId: string; reason: string }> = []
    const pool = new RotomRpcPool({ onReleased: (sessionId, reason) => released.push({ sessionId, reason }) })
    pool.keep(profile, '/w', 'sess-1', fakeRpc(), {})
    pool.keep(profile, '/w', 'sess-1', fakeRpc(), {})
    expect(released).toEqual([{ sessionId: 'sess-1', reason: 'replaced' }])
    await pool.dispose()
    expect(released.at(-1)).toEqual({ sessionId: 'sess-1', reason: 'shutdown' })
  })
})

describe('Pi RPC pool reports a session once', () => {
  it('reports the first reusable keep, not every re-keep', () => {
    const opened: string[] = []
    const pool = new RotomRpcPool({ onOpened: (sessionId) => opened.push(sessionId) })
    pool.keep(profile, '/w', 'sess-1', fakeRpc(), {})
    pool.keep(profile, '/w', 'sess-1', fakeRpc(), {})
    expect(opened).toEqual(['sess-1'])
  })
})
