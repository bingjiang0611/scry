import { expect, it, vi } from 'vitest'
import type { PiAgentProfile } from '../pi-agent-profiles'
import { RotomRpcPool } from './pi-rpc'

const profile: PiAgentProfile = { id: 'rotom', label: 'Rotom', executable: '/usr/local/bin/rotom' }
const env = { PATH: '/usr/bin' }

function fakeRpc(name: string) {
  const closed: string[] = []
  return {
    closed,
    rpc: {
      reusable: () => true,
      close: async () => {
        closed.push(name)
      }
    }
  }
}

it('C1: Pi keeps at most the configured number of idle processes and closes the oldest', async () => {
  const pool = new RotomRpcPool({ maxIdle: 2 })
  const a = fakeRpc('a')
  const b = fakeRpc('b')
  const c = fakeRpc('c')
  pool.keep(profile, '/w', 's1', a.rpc as never, env)
  pool.keep(profile, '/w', 's2', b.rpc as never, env)
  pool.keep(profile, '/w', 's3', c.rpc as never, env)
  expect(pool.size).toBe(2)
  expect(a.closed).toEqual(['a'])
  expect(b.closed).toEqual([])
  expect(await pool.take(profile, '/w', 's3', env)).toBe(c.rpc)
  await pool.dispose()
})

it('C1: an idle Pi process lives for the configured window, not 60 seconds', async () => {
  vi.useFakeTimers()
  try {
    const pool = new RotomRpcPool({ idleMs: 20 * 60_000 })
    const a = fakeRpc('a')
    pool.keep(profile, '/w', 's1', a.rpc as never, env)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(a.closed).toEqual([])
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(a.closed).toEqual(['a'])
  } finally {
    vi.useRealTimers()
  }
})

it('C1: the idle window is clamped to the 15-30 minute C1 range', async () => {
  vi.useFakeTimers()
  try {
    const short = new RotomRpcPool({ idleMs: 1_000 })
    const quick = fakeRpc('quick')
    short.keep(profile, '/w', 's1', quick.rpc as never, env)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(quick.closed).toEqual([])
    await short.dispose()

    const long = new RotomRpcPool({ idleMs: 24 * 3_600_000 })
    const slow = fakeRpc('slow')
    long.keep(profile, '/w', 's1', slow.rpc as never, env)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(slow.closed).toEqual(['slow'])
  } finally {
    vi.useRealTimers()
  }
})
