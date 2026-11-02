import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ attempts: 0, conflict: null as (() => void) | null }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    const tracked = String(args[0]).endsWith('/queue.lock')
    if (tracked) probe.attempts++
    try { return await actual.mkdir(...args) } catch (error) {
      if (tracked && (error as NodeJS.ErrnoException).code === 'EEXIST') probe.conflict?.()
      throw error
    }
  } }
})
import { withDirectoryLock } from './io'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(action: (root: string, lock: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'scry-lock-queue-'))
  try { await action(root, join(root, 'queue.lock')) } finally { await rm(root, { recursive: true, force: true }) }
}
afterEach(() => { probe.attempts = 0; probe.conflict = null; vi.restoreAllMocks() })

it('admits local callers in FIFO order, acquiring the real native lock exactly once each', async () => {
  await fixture(async (_root, lock) => {
    const entered = gate(), release = gate(), order: number[] = []
    const first = withDirectoryLock(lock, async () => { order.push(0); entered.resolve(); await release.promise })
    await entered.promise
    const rest = [1, 2, 3, 4].map(id => withDirectoryLock(lock, async () => { order.push(id) }))
    release.resolve()
    await Promise.all([first, ...rest])
    expect(order).toEqual([0, 1, 2, 3, 4])
    expect(probe.attempts).toBe(5)
  })
})

it('removes a timed-out waiter permanently without blocking the following caller', async () => {
  await fixture(async (_root, lock) => {
    const entered = gate(), release = gate()
    const first = withDirectoryLock(lock, async () => { entered.resolve(); await release.promise })
    await entered.promise
    const cancelled = vi.fn(async () => undefined)
    try {
      await expect(withDirectoryLock(lock, cancelled, { waitMs: 1 })).rejects.toMatchObject({ code: 'ELOCKTIMEOUT' })
    } finally { release.resolve() }
    await first
    await withDirectoryLock(lock, async () => undefined)
    expect(cancelled).not.toHaveBeenCalled()
    expect(probe.attempts).toBe(2)
  })
})

it('rejects an expired admission even before its delayed timeout callback runs', async () => {
  await fixture(async (_root, lock) => {
    const entered = gate(), release = gate()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const first = withDirectoryLock(lock, async () => { entered.resolve(); await release.promise })
    await entered.promise
    const action = vi.fn(async () => undefined)
    const expired = withDirectoryLock(lock, action, { waitMs: 60_000 })
    const following = withDirectoryLock(lock, async () => undefined, { waitMs: 120_000 })
    now += 60_001
    release.resolve()
    const outcomes = await Promise.allSettled([first, expired, following])
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'ELOCKTIMEOUT' } })
    expect(outcomes[2].status).toBe('fulfilled')
    expect(action).not.toHaveBeenCalled()
    expect(probe.attempts).toBe(2)
  })
})

it('releases local admission after failure and never serializes a different lock path', async () => {
  await fixture(async (root, lock) => {
    const entered = gate(), release = gate()
    const first = withDirectoryLock(lock, async () => { entered.resolve(); await release.promise; throw new Error('action failed') })
    const rejected = expect(first).rejects.toThrow('action failed')
    await entered.promise
    let nextRan = false
    const next = withDirectoryLock(lock, async () => { nextRan = true })
    try {
      await withDirectoryLock(join(root, 'independent.lock'), async () => undefined)
      expect(nextRan).toBe(false)
    } finally { release.resolve() }
    await rejected
    await next
    expect(nextRan).toBe(true)
    expect(probe.attempts).toBe(2)
  })
})

it('deducts local queue time from the original native-lock timeout budget', async () => {
  await fixture(async (_root, lock) => {
    const entered = gate(), release = gate()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const first = withDirectoryLock(lock, async () => {
      entered.resolve()
      await release.promise
      // Simulate an external owner replacing the native token: local admission
      // must still check that owner, and cannot receive a fresh wait budget.
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'external-owner', createdAt: now }))
    })
    await entered.promise
    const action = vi.fn(async () => undefined)
    const next = withDirectoryLock(lock, action, { waitMs: 100 })
    const rejected = expect(next).rejects.toMatchObject({ code: 'ELOCKTIMEOUT' })
    now += 80
    probe.conflict = () => { now += 30 }
    release.resolve()
    await first
    await rejected
    expect(action).not.toHaveBeenCalled()
    expect(probe.attempts).toBe(2)
  })
})
