import { fileURLToPath } from 'node:url'
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
})
