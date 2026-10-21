import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerClient, CodexAppServerResponseError } from './codex-app-server'

function manualRequestTimeouts(): {
  schedule: (run: () => void, delayMs: number) => () => void
  activeCount: () => number
  fireNext: () => Promise<void>
} {
  const tasks: Array<{ active: boolean; run: () => void }> = []
  return {
    activeCount: () => tasks.filter((task) => task.active).length,
    schedule: (run) => {
      const task = { active: true, run }
      tasks.push(task)
      return () => { task.active = false }
    },
    fireNext: async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const task = tasks.find((candidate) => candidate.active)
        if (task) {
          task.active = false
          task.run()
          return
        }
        await Promise.resolve()
      }
      throw new Error('no active request timeout')
    }
  }
}

describe('CodexAppServerClient', () => {
  it('never starts or replaces a transport for a same-turn control request', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture] })
    const start = vi.spyOn(client, 'start')
    try {
      await expect(client.requestRunning('turn/steer', { threadId: 'old', expectedTurnId: 'old', input: [] })).rejects.toThrow('not running')
      expect(start).not.toHaveBeenCalled()
      await client.start()
      const pid = client.pid
      start.mockClear()
      await expect(client.requestRunning('skills/list', { cwds: ['/repo'] })).resolves.toMatchObject({ data: [{ cwd: '/repo' }] })
      expect(client.pid).toBe(pid)
      expect(start).not.toHaveBeenCalled()
      await client.shutdown()
      start.mockClear()
      await expect(client.requestRunning('turn/steer', {})).rejects.toThrow('not running')
      expect(start).not.toHaveBeenCalled()
    } finally {
      await client.shutdown()
    }
  })

  it('initializes, correlates requests and forwards notifications', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 10_000 })
    const notifications: Array<{ method: string; emittedAtMs?: number; receivedAtMs: number }> = []
    let resolveCompleted = (): void => {}
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve })
    const off = client.onNotification((method, _params, envelope) => {
      notifications.push({ method, ...envelope })
      if (method === 'turn/completed') resolveCompleted()
    })
    try {
      await expect(client.request('skills/list', { cwds: ['/repo'] })).resolves.toMatchObject({ data: [{ cwd: '/repo' }] })
      const thread = await client.request<{ thread: { id: string } }>('thread/start', { cwd: '/repo' })
      await client.request('turn/start', { threadId: thread.thread.id, input: [] })
      await completed
      expect(notifications).toContainEqual(expect.objectContaining({
        method: 'item/agentMessage/delta',
        emittedAtMs: 1_234,
        receivedAtMs: expect.any(Number)
      }))
      expect(notifications).toContainEqual(expect.objectContaining({ method: 'turn/completed' }))
    } finally {
      off()
      client.close()
    }
  }, 15_000)

  it('preserves explicit native JSON-RPC errors as typed response failures', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 10_000 })
    try {
      let error: unknown
      try {
        await client.request('test/error', { method: 'turn/steer' })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(CodexAppServerResponseError)
      expect(error).toMatchObject({ code: -32601, method: 'test/error' })
    } finally {
      await client.shutdown()
    }
  })

  it('lets the selected run translate native server requests', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 10_000 })
    const off = client.onRequest((method, params) => {
      if (method !== 'item/commandExecution/requestApproval') return undefined
      expect(params).toMatchObject({ threadId: 'thread-1', command: 'pwd' })
      return { decision: 'accept' }
    })
    try {
      await expect(client.request('test/serverRequest')).resolves.toEqual({
        approval: { decision: 'accept' }
      })
    } finally {
      off()
      client.close()
    }
  })

  it('times out one query without killing the shared process or its active turn', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const timeouts = manualRequestTimeouts()
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], scheduleRequestTimeout: timeouts.schedule })
    try {
      await client.start()
      const firstPid = client.pid
      const failure = vi.fn()
      void client.failureForCurrentGeneration().then(failure)
      await client.request('turn/start', { threadId: 'thread-1', hangCompletion: true })
      const received = new Promise<void>((resolve) => client.onNotification((method) => {
        if (method === 'test/requestReceived') resolve()
      }))
      const completed = new Promise<void>((resolve) => client.onNotification((method) => {
        if (method === 'turn/completed') resolve()
      }))
      const hanging = client.request('account/read', { defer: true })
      const rejected = expect(hanging).rejects.toThrow('response_unconfirmed')
      await received
      await timeouts.fireNext()
      await rejected
      // A late response must not poison the next request or disconnect native notifications.
      await client.request('test/release')
      await completed
      expect(failure).not.toHaveBeenCalled()
      await expect(client.request('skills/list', { cwds: ['/repo'] })).resolves.toMatchObject({
        data: [{ cwd: '/repo' }]
      })
      expect(client.pid).toBeTypeOf('number')
      expect(client.pid).toBe(firstPid)
    } finally {
      await client.shutdown()
    }
  })

  it.each(['thread/start', 'thread/resume', 'thread/fork', 'turn/start'])(
    'retains ownership of delayed %s without an execution deadline', async (method) => {
      const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
      const timeouts = manualRequestTimeouts()
      const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], scheduleRequestTimeout: timeouts.schedule })
      try {
        await client.start()
        const received = new Promise<void>((resolve) => client.onNotification((name) => {
          if (name === 'test/requestReceived') resolve()
        }))
        const request = client.request(method, { defer: true })
        await received
        expect(timeouts.activeCount()).toBe(0)
        await client.request('test/release')
        await expect(request).resolves.toMatchObject({ late: true })
      } finally {
        await client.shutdown()
      }
    }
  )

  it('rejects pending execution and generation waiters on explicit shutdown', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture] })
    try {
      await client.start()
      const failure = client.failureForCurrentGeneration()
      const received = new Promise<void>((resolve) => client.onNotification((method) => {
        if (method === 'test/requestReceived') resolve()
      }))
      const request = client.request('turn/start', { defer: true })
      const rejected = expect(request).rejects.toThrow('closed')
      await received
      await client.shutdown()
      await rejected
      await expect(failure).resolves.toMatchObject({ message: expect.stringContaining('closed') })
    } finally {
      await client.shutdown()
    }
  })

  it('tears down a generation rejected during initialize before retrying with a new child', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const root = mkdtempSync(join(tmpdir(), 'scry-codex-init-error-'))
    const timeouts = manualRequestTimeouts()
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: [fixture, 'fail-initialize-once', join(root, 'marker')],
      // This test owns rejection/teardown, not the fixture's wall-clock startup.
      scheduleRequestTimeout: timeouts.schedule
    })
    try {
      const firstStart = client.start()
      const firstPid = client.pid
      await expect(firstStart).rejects.toThrow('initialize denied')
      expect(client.pid).toBeUndefined()
      await expect(client.request('skills/list', { cwds: ['/repo'] })).resolves.toMatchObject({
        data: [{ cwd: '/repo' }]
      })
      expect(client.pid).toBeTypeOf('number')
      expect(client.pid).not.toBe(firstPid)
    } finally {
      await client.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('propagates stdin errors, closes the owned child and fences late errors from the replacement', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture] })
    await client.start()
    const child = client['process']!
    try {
      const failure = client.failureForCurrentGeneration()
      const error = Object.assign(new Error('fixture broken stdin'), { code: 'EPIPE' })
      expect(() => child.stdin.emit('error', error)).not.toThrow()
      await expect(failure).resolves.toBe(error)
      await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true)
      await expect(client.request('skills/list', { cwds: ['/repo'] })).resolves.toMatchObject({ data: [{ cwd: '/repo' }] })
      const replacement = client.pid
      expect(replacement).not.toBe(child.pid)
      expect(() => child.stdin.emit('error', new Error('late stale pipe error'))).not.toThrow()
      expect(client.pid).toBe(replacement)
    } finally {
      // Also owns cleanup when the regression deliberately omits stream teardown.
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill('SIGKILL') })
      }
      await client.shutdown()
    }
  })

  it('tears down a generation when the initialized notification cannot be written', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const root = mkdtempSync(join(tmpdir(), 'scry-codex-init-write-'))
    const timeouts = manualRequestTimeouts()
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: [fixture, 'close-stdin-once', join(root, 'marker')],
      scheduleRequestTimeout: timeouts.schedule
    })
    try {
      const firstStart = client.start()
      const firstPid = client.pid
      await expect(firstStart).rejects.toThrow()
      expect(client.pid).toBeUndefined()
      await expect(client.request('skills/list', { cwds: ['/repo'] })).resolves.toMatchObject({
        data: [{ cwd: '/repo' }]
      })
      expect(client.pid).not.toBe(firstPid)
    } finally {
      await client.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
