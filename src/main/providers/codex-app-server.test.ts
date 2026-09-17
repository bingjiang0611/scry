import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerClient } from './codex-app-server'

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
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: [fixture, 'fail-initialize-once', join(root, 'marker')],
      requestTimeoutMs: 2_000
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

  it('tears down a generation when the initialized notification cannot be written', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const root = mkdtempSync(join(tmpdir(), 'scry-codex-init-write-'))
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: [fixture, 'close-stdin-once', join(root, 'marker')],
      requestTimeoutMs: 2_000
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
