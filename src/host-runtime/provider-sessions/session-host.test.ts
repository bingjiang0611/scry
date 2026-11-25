import { expect, it, vi } from 'vitest'
import {
  ProviderSessionCapExceededError,
  ProviderSessionHost
} from './session-host'
import { environmentFingerprint, mcpFingerprint, providerSessionKey } from './session-key'

function fakeSessions() {
  const closed: string[] = []
  const counts: Record<string, number> = {}
  const open = async (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1
    return {
      value: { name },
      sessionId: `native-${name}`,
      close: () => {
        closed.push(name)
      }
    }
  }
  return { open, closed, counts }
}

it('reuses the same session for a matching key and reports the native session id', async () => {
  const host = new ProviderSessionHost<{ name: string }>({ now: () => 1_000 })
  const { open, counts } = fakeSessions()
  const first = await host.acquire('k1', () => open('a'))
  expect(first).toMatchObject({ sessionId: 'native-a', reused: false })
  await host.settle('k1', { reusable: true })
  const second = await host.acquire('k1', () => open('a'))
  expect(second).toMatchObject({ sessionId: 'native-a', reused: true })
  expect(counts.a).toBe(1)
})

it('opens a new session when the key changed and releases the old one', async () => {
  const host = new ProviderSessionHost<{ name: string }>({ now: () => 1_000 })
  const { open, closed } = fakeSessions()
  await host.acquire('k1', () => open('a'))
  await host.settle('k1', { reusable: true })
  const next = await host.acquire('k2', () => open('b'))
  expect(next).toMatchObject({ sessionId: 'native-b', reused: false })
  await host.closeAll()
  expect(closed).toEqual(['a', 'b'])
})

it('evicts the least recently used idle session when the cap is reached', async () => {
  const host = new ProviderSessionHost<{ name: string }>({ now: () => 1_000, maxSessions: 2 })
  const { open, closed } = fakeSessions()
  await host.acquire('k1', () => open('a'))
  await host.settle('k1', { reusable: true })
  await host.acquire('k2', () => open('b'))
  await host.settle('k2', { reusable: true })
  await host.acquire('k3', () => open('c'))
  expect(closed).toEqual(['a'])
  expect(host.size).toBe(2)
})

it('refuses to open past the cap when every session is busy', async () => {
  const host = new ProviderSessionHost<{ name: string }>({ now: () => 1_000, maxSessions: 1 })
  const { open } = fakeSessions()
  await host.acquire('k1', () => open('a'))
  await expect(host.acquire('k2', () => open('b'))).rejects.toBeInstanceOf(ProviderSessionCapExceededError)
})

it('keeps a session with background tasks past the idle window, up to four hours', async () => {
  vi.useFakeTimers()
  try {
    let released: string | undefined
    const host = new ProviderSessionHost<{ name: string }>({
      now: () => Date.now(),
      idleMs: 15 * 60_000,
      onReleased: (record) => {
        released = `${record.key}:${record.reason}`
      }
    })
    const { closed } = fakeSessions()
    await host.acquire('k1', async () => ({
      value: { name: 'a' },
      sessionId: 'native-a',
      close: () => {
        closed.push('a')
        return undefined
      }
    }))
    await host.settle('k1', { reusable: true, keepForBackground: true })
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    expect(closed).toEqual([])
    await vi.advanceTimersByTimeAsync(4 * 3_600_000)
    expect(closed).toEqual(['a'])
    expect(released).toBe('k1:background_expired')
  } finally {
    vi.useRealTimers()
  }
})

it('releases an idle session after the idle window', async () => {
  vi.useFakeTimers()
  try {
    const host = new ProviderSessionHost<{ name: string }>({ now: () => Date.now(), idleMs: 15 * 60_000 })
    const { closed } = fakeSessions()
    await host.acquire('k1', async () => ({
      value: { name: 'a' },
      sessionId: 'native-a',
      close: () => {
        closed.push('a')
        return undefined
      }
    }))
    await host.settle('k1', { reusable: true })
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1)
    expect(closed).toEqual(['a'])
    expect(host.size).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

// R4: two conversations can want the same key at the same time. The host used to close the live
// process to make room, so the first conversation died mid-turn.
it('R4: a concurrent acquire for a busy key never closes the live session', async () => {
  const host = new ProviderSessionHost<{ name: string }>({ now: () => 1_000, maxSessions: 4 })
  const { open, closed, counts } = fakeSessions()
  const first = await host.acquire('k1', () => open('a'))
  expect(first.reused).toBe(false)

  const secondPromise = host.acquire('k1', () => open('b'))
  // The live session is still the first one: nothing was closed to make room.
  expect(closed).toEqual([])
  await host.settle('k1', { reusable: true })
  const second = await secondPromise
  // Once the turn ended the entry is idle, so the second turn reuses it instead of a second spawn.
  expect(second).toMatchObject({ sessionId: 'native-a', reused: true })
  expect(counts.b).toBeUndefined()
  expect(closed).toEqual([])
  await host.closeAll()
})

it('derives a stable key that changes with every identity part', () => {
  const base = {
    sessionBinding: 's1',
    continuationKey: 'agy:home',
    mcpFingerprint: 'm1',
    permissionMode: 'default',
    environmentFingerprint: 'e1'
  }
  expect(providerSessionKey(base)).toBe(providerSessionKey({ ...base }))
  expect(providerSessionKey(base)).toMatch(/^psession:[0-9a-f]{64}$/)
  for (const part of ['sessionBinding', 'continuationKey', 'mcpFingerprint', 'permissionMode', 'environmentFingerprint'] as const) {
    expect(providerSessionKey({ ...base, [part]: 'changed' })).not.toBe(providerSessionKey(base))
  }
})

it('fingerprints MCP servers and the launch environment without leaking values', () => {
  const servers = {
    zed: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
    alpha: { type: 'stdio', command: '/bin/x', args: ['--flag'] }
  }
  expect(mcpFingerprint(servers)).toBe(mcpFingerprint({ alpha: servers.alpha, zed: servers.zed }))
  expect(mcpFingerprint(servers)).not.toBe(mcpFingerprint({ ...servers, alpha: { ...servers.alpha, args: ['--other'] } }))
  expect(environmentFingerprint({ PATH: '/usr/bin', HOME: '/tmp' })).toBe(
    environmentFingerprint({ HOME: '/tmp', PATH: '/usr/bin' })
  )
  expect(environmentFingerprint({ PATH: '/usr/bin' })).not.toContain('/usr/bin')
})

it('reuses a session through the alias derived from the native id it just opened', async () => {
  const host = new ProviderSessionHost<{ name: string }>({ now: () => 1_000 })
  const { open, counts } = fakeSessions()
  const first = await host.acquire('fresh-key', () => open('a'))
  expect(host.alias('fresh-key', 'resumed-key')).toBe(true)
  await host.settle('fresh-key', { reusable: true })
  const second = await host.acquire('resumed-key', () => open('a2'))
  expect(second).toMatchObject({ sessionId: 'native-a', reused: true })
  expect(counts.a2).toBeUndefined()
  await host.release('resumed-key', 'idle')
  expect(host.size).toBe(0)
  expect(first.sessionId).toBe('native-a')
})
