import { describe, expect, it, vi } from 'vitest'
import type { Query } from '@qoder-ai/qoder-agent-sdk'
import { createQoderSessionPool, type QoderOpenedSession, type QoderSessionOpener } from './qoder-session-pool'

/** A fake SDK query that stays open until the pool closes it, so reuse is observable. */
function fakeSdk() {
  const queue: Record<string, unknown>[] = []
  let wake: (() => void) | undefined
  let done = false
  const close = vi.fn(async () => { done = true; wake?.(); wake = undefined })
  const query = {
    close,
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
  return { query: query as unknown as Query, close, push: (m: Record<string, unknown>) => { queue.push(m); wake?.(); wake = undefined } }
}

function fakePool(overrides: { idleMs?: number; cap?: number } = {}) {
  const opened: { key: string; sdk: ReturnType<typeof fakeSdk> }[] = []
  const disposed: string[] = []
  const released: { key: string; reason: string }[] = []
  const native: { key: string; id: string }[] = []
  const pool = createQoderSessionPool({
    provider: 'qoder_cli',
    idleMs: overrides.idleMs ?? 60_000,
    cap: overrides.cap ?? 8,
    observer: {
      onReleased: (key, reason) => { released.push({ key, reason }) },
      onNativeSessionId: (key, id) => { native.push({ key, id }) }
    }
  })
  const opener = (key: string): QoderSessionOpener => (): QoderOpenedSession => {
    const sdk = fakeSdk()
    opened.push({ key, sdk })
    return { query: sdk.query, dispose: () => { disposed.push(key) } }
  }
  return { pool, opened, disposed, released, native, opener }
}

describe('Qoder kept-session pool', () => {
  it('reuses one session for a repeated key and opens it once', () => {
    const fake = fakePool()
    const first = fake.pool.acquire('k1', fake.opener('k1'))
    first.release()
    const second = fake.pool.acquire('k1', fake.opener('k1'))
    expect(second.query).toBe(first.query)
    expect(fake.opened).toHaveLength(1)
    expect(fake.pool.keys()).toEqual(['k1'])
  })

  it('opens a separate session when the key differs, because the key carries the turn options', () => {
    const fake = fakePool()
    fake.pool.acquire('k1', fake.opener('k1')).release()
    fake.pool.acquire('k2', fake.opener('k2')).release()
    expect(fake.opened.map((entry) => entry.key)).toEqual(['k1', 'k2'])
  })

  it('releases an idle session with the shared reason and disposes its per-session state', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakePool({ idleMs: 1_000 })
      fake.pool.acquire('k1', fake.opener('k1')).release()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fake.released).toEqual([{ key: 'k1', reason: 'idle' }])
      expect(fake.disposed).toEqual(['k1'])
      expect(fake.opened[0].sdk.close).toHaveBeenCalledOnce()
      expect(fake.pool.keys()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the native session for the key so the host can bind it', () => {
    const fake = fakePool()
    fake.pool.acquire('k1', fake.opener('k1')).recordNativeSession('native-1')
    expect(fake.native).toEqual([{ key: 'k1', id: 'native-1' }])
  })

  it('never evicts a session that is still serving a turn', async () => {
    const fake = fakePool({ cap: 1 })
    const busy = fake.pool.acquire('busy', fake.opener('busy'))
    const turn = busy.beginTurn()
    const parked = turn[Symbol.asyncIterator]().next()
    await new Promise((resolve) => setTimeout(resolve, 0))
    fake.pool.acquire('new', fake.opener('new')).release()
    expect(fake.pool.keys()).toContain('busy')
    expect(fake.disposed).not.toContain('busy')
    turn.end()
    await parked
    await fake.pool.disposeAll()
  })

  it('disposes every session on shutdown and reports the reason', async () => {
    const fake = fakePool()
    fake.pool.acquire('k1', fake.opener('k1')).release()
    fake.pool.acquire('k2', fake.opener('k2')).release()
    await fake.pool.disposeAll()
    expect(fake.released.map((entry) => entry.reason)).toEqual(['dispose', 'dispose'])
    expect(fake.disposed.sort()).toEqual(['k1', 'k2'])
    expect(fake.pool.keys()).toEqual([])
  })

  // R12: a crashed process cannot serve the next turn, and a busy key must not be overwritten.
  it('opens a fresh session after the previous one died', () => {
    const fake = fakePool()
    const dead = fake.pool.acquire('k1', fake.opener('k1'))
    dead.release({ dead: true })
    const next = fake.pool.acquire('k1', fake.opener('k1'))
    expect(fake.opened).toHaveLength(2)
    expect(next.query).not.toBe(dead.query)
    expect(fake.released.map((row) => row.reason)).toEqual(['crashed'])
  })

  it('does not reuse a session that reported the process gone', () => {
    const fake = fakePool()
    const first = fake.pool.acquire('k1', fake.opener('k1'))
    first.markExited()
    const second = fake.pool.acquire('k1', fake.opener('k1'))
    expect(fake.opened).toHaveLength(2)
    expect(second.query).not.toBe(first.query)
  })

  it('keeps a busy key separate instead of overwriting its live entry', () => {
    const fake = fakePool()
    const busy = fake.pool.acquire('k1', fake.opener('k1'))
    const collided = fake.pool.acquire('k1', fake.opener('k1'))
    expect(fake.opened).toHaveLength(2)
    expect(collided.query).not.toBe(busy.query)
    // The old lease still owns its own process: releasing it must not close the new one.
    busy.release()
    expect(fake.opened[1]!.sdk.close).not.toHaveBeenCalled()
    // And reuse takes the idle entry rather than reopening.
    expect(fake.pool.acquire('k1', fake.opener('k1')).query).toBe(busy.query)
  })
})
