import { describe, expect, it, vi } from 'vitest'

const appServer = vi.hoisted(() => ({
  request: vi.fn(),
  start: vi.fn(),
  onNotification: vi.fn(),
  onRequest: vi.fn(),
  failureForCurrentGeneration: vi.fn(),
  shutdown: vi.fn(),
  options: [] as Array<Record<string, unknown>>
}))

vi.mock('./codex-app-server', () => ({
  CodexAppServerResponseError: class extends Error {
    readonly code: number | undefined
    readonly data: unknown
    readonly method: string
    constructor(method: string, error: { code?: number; message?: string; data?: unknown }) {
      super(error.message)
      this.code = error.code
      this.data = error.data
      this.method = method
    }
  },
  CodexAppServerClient: class {
    request = appServer.request
    requestRunning = appServer.request
    start = appServer.start
    onNotification = appServer.onNotification
    onRequest = appServer.onRequest
    failureForCurrentGeneration = appServer.failureForCurrentGeneration
    shutdown = appServer.shutdown
    pid = 123
    constructor(options: Record<string, unknown>) {
      appServer.options.push(options)
    }
    close() {}
  }
}))

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/codex',
  runtimeCliEnv: () => ({}),
  shellEnv: () => ({})
}))

import { createCodexAdapter } from './codex'

describe('A5: Codex app-server exclusivity', () => {
  it('reports an exclusive app-server client only when this run is its only activity', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    appServer.onNotification.mockReturnValue(() => {})
    // The real client always hands back an unsubscribe function; a bare vi.fn() would make the run's
    // finally block call undefined, which is a fixture defect, not adapter behaviour.
    appServer.onRequest.mockReturnValue(() => {})
    // A running client always answers with a pending failure promise; without one the run cannot
    // race native completion against a transport failure and the finally block never runs.
    appServer.failureForCurrentGeneration.mockImplementation(() => new Promise<never>(() => {}))
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return new Promise((resolve) => resolvers.push(resolve))
      if (method === 'turn/start') return { turn: { id: `turn-${resolvers.length}`, status: 'inProgress' } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`unexpected request: ${method}`)
    })
    const adapter = createCodexAdapter()
    const first = adapter.run({ runId: 'run-exclusive-1', prompt: 'one', cwd: '/repo-a5', attachments: [], emit: () => {} })
    const second = adapter.run({ runId: 'run-exclusive-2', prompt: 'two', cwd: '/repo-a5', attachments: [], emit: () => {} })
    try {
      await vi.waitFor(() => expect(resolvers).toHaveLength(2))
      resolvers[0]({ thread: { id: 'thread-exclusive-1' } })
      resolvers[1]({ thread: { id: 'thread-exclusive-2' } })
      await vi.waitFor(() => expect(second.getExternalSessionId()).toBe('thread-exclusive-2'))

      // Both runs share one app-server client, so neither may auto-kill it.
      expect(first.forceKillScope).toBe('shared_transport')
      expect(first.exclusiveKillAvailable?.()).toBe(false)
      expect(second.exclusiveKillAvailable?.()).toBe(false)

      // A run alone on its own workspace server may reclaim it after the graceful window.
      const alone = adapter.run({ runId: 'run-exclusive-3', prompt: 'three', cwd: '/repo-a5-alone', attachments: [], emit: () => {} })
      try {
        await vi.waitFor(() => expect(resolvers).toHaveLength(3))
        resolvers[2]({ thread: { id: 'thread-exclusive-3' } })
        await vi.waitFor(() => expect(alone.exclusiveKillAvailable?.()).toBe(true))
      } finally {
        alone.interrupt()
      }
    } finally {
      // Interrupt both and stop waiting for native completion; the fixture keeps turns open.
      first.interrupt()
      second.interrupt()
      await Promise.race([
        Promise.allSettled([first.promise, second.promise]),
        new Promise((resolve) => setTimeout(resolve, 50))
      ])
    }
  })

})
