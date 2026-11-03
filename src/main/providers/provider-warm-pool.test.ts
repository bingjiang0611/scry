import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderWarmPool, providerWarmKey } from './provider-warm-pool'

interface FakeProcess {
  id: string
  reusable: boolean
  closed: number
}

const pools: Array<ProviderWarmPool<FakeProcess>> = []

function pool(overrides: Partial<ConstructorParameters<typeof ProviderWarmPool<FakeProcess>>[0]> = {}) {
  const created = new ProviderWarmPool<FakeProcess>({
    limit: 8,
    idleMs: 60_000,
    reusable: entry => entry.reusable,
    sameEnvironment: (parked, next) => JSON.stringify(parked) === JSON.stringify(next),
    close: entry => { entry.closed++ },
    ...overrides
  })
  pools.push(created)
  return created
}

const scope = { profileId: 'pi:one', cwd: '/workspace' }
const other = { profileId: 'pi:two', cwd: '/workspace' }
const elsewhere = { profileId: 'pi:one', cwd: '/other' }
let serial = 0
const fake = (overrides: Partial<FakeProcess> = {}): FakeProcess => ({ id: `process-${++serial}`, reusable: true, closed: 0, ...overrides })

afterEach(async () => {
  vi.useRealTimers()
  for (const created of pools.splice(0)) await created.dispose()
})

describe('ProviderWarmPool', () => {
  it('keys on every identity input in a fixed order', () => {
    expect(providerWarmKey({ cwd: '/a', provider: 'pi', profile: 'p' })).toBe(providerWarmKey({ profile: 'p', cwd: '/a', provider: 'pi' }))
    expect(providerWarmKey({ provider: 'pi', cwd: '/a' })).not.toBe(providerWarmKey({ provider: 'pi', cwd: '/b' }))
    expect(providerWarmKey({ provider: 'pi', cwd: '/a' })).not.toBe(providerWarmKey({ provider: 'codex', cwd: '/a' }))
  })

  it('hands a parked value to the next read and renews it on park', async () => {
    const created = pool()
    const first = fake()
    created.park('k', first, { PATH: '/bin' }, scope)
    expect(await created.take('k', { PATH: '/bin' })).toBe(first)
    // Taking removes it: a second read must not see a value another read owns.
    expect(await created.take('k', { PATH: '/bin' })).toBeUndefined()
    expect(created.size).toBe(0)
    expect(first.closed).toBe(0)
  })

  it('closes a parked value that is no longer reusable or that saw another environment', async () => {
    const created = pool()
    const failed = fake({ reusable: false })
    created.park('failed', failed, 1, scope)
    expect(await created.take('failed', 1)).toBeUndefined()
    expect(failed.closed).toBe(1)

    const mismatched = fake()
    created.park('env', mismatched, { HOME: '/isolated/a' }, scope)
    expect(await created.take('env', { HOME: '/isolated/b' })).toBeUndefined()
    expect(mismatched.closed).toBe(1)
  })

  it('touches only a parked key and closes it when idle time expires', async () => {
    vi.useFakeTimers()
    const created = pool({ idleMs: 1_000 })
    const parked = fake()
    created.park('k', parked, 1, scope)
    expect(created.touch('missing')).toBe(false)
    expect(created.touch('k')).toBe(true)
    await vi.advanceTimersByTimeAsync(900)
    expect(parked.closed).toBe(0)
    expect(created.touch('k')).toBe(true)
    await vi.advanceTimersByTimeAsync(900)
    expect(parked.closed).toBe(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(parked.closed).toBe(1)
    expect(created.size).toBe(0)
  })

  it('evicts the oldest entry past the limit', async () => {
    const created = pool({ limit: 2 })
    const [a, b, c] = [fake(), fake(), fake()]
    created.park('a', a, 1, scope)
    created.park('b', b, 1, scope)
    created.park('c', c, 1, scope)
    expect(created.size).toBe(2)
    expect(a.closed).toBe(1)
    expect(await created.take('b', 1)).toBe(b)
    expect(await created.take('c', 1)).toBe(c)
  })

  it('invalidates only the matching workspace and profile', async () => {
    const created = pool()
    const sameWorkspace = fake()
    const otherProfile = fake()
    const otherWorkspace = fake()
    created.park('a', sameWorkspace, 1, scope)
    created.park('b', otherProfile, 1, other)
    created.park('c', otherWorkspace, 1, elsewhere)
    await created.invalidate({ cwd: '/workspace' })
    // A workspace invalidation closes both profiles in that workspace, not the
    // warm process of an unrelated workspace.
    expect(sameWorkspace.closed).toBe(1)
    expect(otherProfile.closed).toBe(1)
    expect(otherWorkspace.closed).toBe(0)
    expect(created.size).toBe(1)
    await created.invalidate({ cwd: '/workspace', profileId: 'pi:one' })
    expect(otherWorkspace.closed).toBe(0)
  })

  it('closes everything on dispose and reports close failures without throwing', async () => {
    const failures: unknown[] = []
    const created = pool({
      close: entry => {
        entry.closed++
        if (entry.id === 'bad') throw new Error('close failed')
      },
      onCloseError: error => failures.push(error)
    })
    const good = fake()
    const bad = fake({ id: 'bad' })
    created.park('good', good, 1, scope)
    created.park('bad', bad, 1, scope)
    await created.dispose()
    expect([good.closed, bad.closed]).toEqual([1, 1])
    expect(failures).toHaveLength(1)
    expect(created.size).toBe(0)
  })
})
