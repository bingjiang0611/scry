import { describe, expect, it, vi } from 'vitest'
import type { Query } from '@qoder-ai/qoder-agent-sdk'
import { createQoderSessionPool } from './qoder-session-pool'

/** A fake SDK query that records what the pool handed it and answers one message per turn. */
function fakePool(overrides: { idleMs?: number; cap?: number } = {}) {
  const opened: { key: string; signal: AbortSignal; prompt: AsyncIterable<unknown> }[] = []
  const closed: string[] = []
  const released: { key: string; reason: string }[] = []
  const pool = createQoderSessionPool({
    provider: 'qoder_cli',
    idleMs: overrides.idleMs ?? 60_000,
    cap: overrides.cap ?? 8,
    observer: { onReleased: (key, reason) => { released.push({ key, reason }) } },
    open: (key, prompt, signal) => {
      opened.push({ key, signal, prompt })
      const queue: Record<string, unknown>[] = []
      let wake: (() => void) | undefined
      let done = false
      const query = {
        close: vi.fn(async () => { done = true; closed.push(key); wake?.() }),
        interrupt: vi.fn(async () => undefined),
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const next = queue.shift()
            if (next) { yield next; continue }
            if (done) return
            await new Promise<void>((resolve) => { wake = resolve })
          }
        }
      }
      return query as unknown as Query
    }
  })
  return { pool, opened, closed, released }
}

describe('Qoder kept-session pool', () => {
  it('reuses one session for a repeated key and reports it once', () => {
    const fake = fakePool()
    const first = fake.pool.acquire('k1')
    first.release()
    const second = fake.pool.acquire('k1')
    expect(second.query).toBe(first.query)
    expect(fake.opened).toHaveLength(1)
    expect(fake.pool.keys()).toEqual(['k1'])
  })

  it('opens a separate session when the key differs, because the key carries the turn options', () => {
    const fake = fakePool()
    fake.pool.acquire('k1').release()
    fake.pool.acquire('k2').release()
    expect(fake.opened.map((entry) => entry.key)).toEqual(['k1', 'k2'])
  })

  it('releases an idle session with the shared reason and closes its prompt stream', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakePool({ idleMs: 1_000 })
      const lease = fake.pool.acquire('k1')
      lease.release()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fake.released).toEqual([{ key: 'k1', reason: 'idle' }])
      expect(fake.closed).toEqual(['k1'])
      expect(fake.pool.keys()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never evicts a session that is still serving a turn', async () => {
    const fake = fakePool({ cap: 1 })
    const busy = fake.pool.acquire('busy')
    // Park a reader on the busy session, so it is not idle.
    const turn = busy.beginTurn()
    const parked = turn[Symbol.asyncIterator]().next()
    await new Promise((resolve) => setTimeout(resolve, 0))
    fake.pool.acquire('new').release()
    expect(fake.pool.keys()).toContain('busy')
    expect(fake.closed).not.toContain('busy')
    turn.end()
    await fake.pool.disposeAll()
    await parked.catch(() => undefined)
  })

  it('disposes every session on shutdown and reports the reason', async () => {
    const fake = fakePool()
    fake.pool.acquire('k1').release()
    fake.pool.acquire('k2').release()
    await fake.pool.disposeAll()
    expect(fake.released.map((entry) => entry.reason)).toEqual(['dispose', 'dispose'])
    expect(fake.pool.keys()).toEqual([])
  })
})
