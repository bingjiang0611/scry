import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const appServer = vi.hoisted(() => ({
  created: [] as Array<{ pid: number; shutdown: ReturnType<typeof vi.fn> }>
}))

vi.mock('./codex-app-server', () => ({
  CodexAppServerResponseError: class extends Error {},
  CodexAppServerClient: class {
    shutdown = vi.fn(async () => {})
    close = vi.fn()
    request = vi.fn(async () => ({}))
    start = vi.fn(async () => {})
    constructor() {
      appServer.created.push(this as unknown as { pid: number; shutdown: ReturnType<typeof vi.fn> })
    }
    get pid() {
      return appServer.created.indexOf(this as never) + 1000
    }
  }
}))

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/codex',
  runtimeCliEnv: () => ({}),
  shellEnv: () => ({})
}))

import { codexIdleWindowMs, createCodexClientPool } from './codex-client-pool'

const homes: string[] = []
function home(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scry-codex-pool-'))
  homes.push(directory)
  return directory
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
  appServer.created.length = 0
})

// C1: a Codex app-server is a session. The pool is the only place that knows when one opened, which
// thread it carries, and why it was released — so the records come from here, not from log lines.
describe('Codex client pool sessions', () => {
  it('opens one client per key and reports it once', () => {
    const reasons: Array<[string, string]> = []
    const opened: Array<[string, string]> = []
    const pool = createCodexClientPool({
      homeDir: home(),
      sessions: {
        onOpened: (key, provider) => opened.push([key, provider]),
        onReleased: (key, reason) => reasons.push([key, reason])
      }
    })
    const first = pool.getClient('/tmp/work-a')
    const second = pool.getClient('/tmp/work-a')
    expect(second).toBe(first)
    expect(appServer.created).toHaveLength(1)
    expect(opened).toHaveLength(1)
    expect(opened[0]?.[1]).toBe('codex')
    expect(reasons).toEqual([])
  })

  it('reports the native thread and the release reason', async () => {
    const native: Array<[string, string]> = []
    const reasons: Array<[string, string]> = []
    const pool = createCodexClientPool({
      homeDir: home(),
      sessions: {
        onNativeSessionId: (key, threadId) => native.push([key, threadId]),
        onReleased: (key, reason) => reasons.push([key, reason])
      }
    })
    const client = pool.getClient('/tmp/work-b')
    pool.recordNativeSession(client, 'thread-42')
    expect(native).toHaveLength(1)
    expect(native[0]?.[1]).toBe('thread-42')
    await pool.closeAll()
    expect(reasons).toHaveLength(1)
    expect(reasons[0]?.[1]).toBe('dispose')
  })

  it('releases an idle client after the C1 window and says why', async () => {
    vi.useFakeTimers()
    try {
      const reasons: Array<[string, string]> = []
      const pool = createCodexClientPool({
        homeDir: home(),
        idleWindowMs: 1_000,
        sessions: { onReleased: (key, reason) => reasons.push([key, reason]) }
      })
      pool.getClient('/tmp/work-c')
      pool.scheduleClientShutdown(pool.getClient('/tmp/work-c'))
      await vi.advanceTimersByTimeAsync(1_001)
      expect(reasons.map((entry) => entry[1])).toEqual(['idle'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('evicts the least recently used client past the cap', async () => {
    const reasons: Array<[string, string]> = []
    const pool = createCodexClientPool({
      homeDir: home(),
      maxClients: 2,
      sessions: { onReleased: (key, reason) => reasons.push([key, reason]) }
    })
    pool.getClient('/tmp/work-1')
    await new Promise((resolve) => setTimeout(resolve, 2))
    pool.getClient('/tmp/work-2')
    await new Promise((resolve) => setTimeout(resolve, 2))
    pool.getClient('/tmp/work-3')
    // Release is a real async shutdown; the reason is recorded after it settles.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(reasons.map((entry) => entry[1])).toEqual(['lru'])
    await pool.closeAll()
  })

  it('keeps the C1 idle window inside 15 to 30 minutes', () => {
    expect(codexIdleWindowMs({})).toBe(20 * 60_000)
    expect(codexIdleWindowMs({ SCRY_CODEX_IDLE_MS: '60000' })).toBe(15 * 60_000)
    expect(codexIdleWindowMs({ SCRY_CODEX_IDLE_MS: '99999999' })).toBe(30 * 60_000)
    expect(codexIdleWindowMs({ SCRY_CODEX_IDLE_MS: 'abc' })).toBe(20 * 60_000)
  })
})
