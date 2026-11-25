import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempDirs, tempDir } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { DaemonRunTransport } from '../main/daemon-run-transport'
import { DaemonRunRuntime } from '../main/daemon-run-runtime'
import { startDaemonRunEvents } from '../main/daemon-run-events'
import { DaemonRunRefusedError } from '../main/daemon-run-admission'
import { createDaemonRunSurface } from '../main/bootstrap/daemon-run-surface'

afterEach(cleanupTempDirs)


const SAME_SESSION_REFUSAL = '同一会话已有一轮正在运行'

const settle = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ ok: true as const, value }),
  (error: unknown) => ({ ok: false as const, error: error as Error })
)

async function until<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined || Date.now() >= deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('daemon same-session exclusion', () => {
  it('refuses a second start into a live session exactly as in process, and runs a new session beside it', async () => {
    const inputs = join(tempDir(), 'inputs.jsonl')
    const saved = process.env.SCRY_ELECTRON_SMOKE_INPUTS
    process.env.SCRY_ELECTRON_SMOKE_INPUTS = inputs
    const daemon = await startTestDaemon()
    const transport = new DaemonRunTransport((request) => daemon.request(request))
    const runtime = new DaemonRunRuntime({ transport, send: () => undefined })
    const events = startDaemonRunEvents({ transport, runtime, send: () => undefined, waitMs: 500 })
    const surface = createDaemonRunSurface({ transport, runtime, currentCwd: () => daemon.workspace })
    const start = (prompt: string, extra: Record<string, unknown> = {}) => surface.start({
      prompt, providerId: 'codex', cwd: daemon.workspace, commandId: randomUUID(), ...extra
    })
    try {
      const first = await start(`native composer b4v hold first ${randomUUID().slice(0, 8)}`)
      const session = await until(() => runtime.runView(first.runId)?.externalSessionId, 10_000)
      expect(session).toBeTruthy()

      const samePrompt = `native composer complete b4v same ${randomUUID().slice(0, 8)}`
      const same = await settle(start(samePrompt, { expectedExternalSessionId: session }))
      expect(same.ok).toBe(false)
      if (same.ok) return
      expect(same.error).toBeInstanceOf(DaemonRunRefusedError)
      expect(same.error.message).toBe(SAME_SESSION_REFUSAL)
      expect(runtime.runView(first.runId)?.done).not.toBe(true)
      const asked = () => existsSync(inputs) ? readFileSync(inputs, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).prompt) : []
      expect(asked()).not.toContain(samePrompt)

      const freshPrompt = `native composer complete b4v new ${randomUUID().slice(0, 8)}`
      const fresh = await start(freshPrompt, { expectedExternalSessionId: null })
      expect(await until(() => runtime.runView(fresh.runId)?.done === true ? true : undefined, 10_000)).toBe(true)
      expect(runtime.runView(fresh.runId)?.error ?? null).toBeNull()
      expect(runtime.runView(first.runId)?.done).not.toBe(true)
      expect(asked()).toContain(freshPrompt)

      await surface.stop(first.runId)
      expect(await until(() => runtime.runView(first.runId)?.done === true ? true : undefined, 10_000)).toBe(true)
    } finally {
      events.dispose()
      runtime.dispose()
      await daemon.dispose()
      if (saved === undefined) delete process.env.SCRY_ELECTRON_SMOKE_INPUTS
      else process.env.SCRY_ELECTRON_SMOKE_INPUTS = saved
    }
  }, 60_000)
})
