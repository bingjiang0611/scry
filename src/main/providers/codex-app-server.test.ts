import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAppServerClient } from './codex-app-server'

describe('CodexAppServerClient', () => {
  it('initializes, correlates requests and forwards notifications', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 10_000 })
    const notifications: Array<{ method: string; emittedAtMs?: number; receivedAtMs: number }> = []
    const off = client.onNotification((method, _params, envelope) => notifications.push({ method, ...envelope }))
    try {
      await expect(client.request('skills/list', { cwds: ['/repo'] })).resolves.toMatchObject({ data: [{ cwd: '/repo' }] })
      const thread = await client.request<{ thread: { id: string } }>('thread/start', { cwd: '/repo' })
      await client.request('turn/start', { threadId: thread.thread.id, input: [] })
      await new Promise((resolve) => setTimeout(resolve, 20))
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

  it('terminates a timed-out generation before starting a clean child', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 1_000 })
    try {
      await client.start()
      const firstPid = client.pid
      await expect(client.request('test/hang')).rejects.toThrow('timed out')
      await expect(client.request('skills/list', { cwds: ['/repo'] })).resolves.toMatchObject({
        data: [{ cwd: '/repo' }]
      })
      expect(client.pid).toBeTypeOf('number')
      expect(client.pid).not.toBe(firstPid)
    } finally {
      client.close()
    }
  })

  it('signals a completed turn waiter when another request kills its generation', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 1_000 })
    try {
      await client.start()
      const failure = client.failureForCurrentGeneration()
      await client.request('turn/start', { threadId: 'thread-1', input: [], hangCompletion: true })
      const timeout = client.request('test/hang')
      const timeoutExpectation = expect(timeout).rejects.toThrow('timed out')

      await expect(failure).resolves.toMatchObject({ message: expect.stringContaining('timed out') })
      await timeoutExpectation
    } finally {
      client.close()
    }
  })

  it('marks turn/start timeout termination as unconfirmed at the failure boundary', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 1_000 })
    try {
      await expect(client.request('turn/start', { hang: true })).rejects.toThrow('termination_unconfirmed')
    } finally {
      client.close()
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
      await new Promise((resolve) => setTimeout(resolve, 20))
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
      await new Promise((resolve) => setTimeout(resolve, 20))
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
