import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { TraceEvent } from '../shared/trace'
import type { TraceBatch } from '../main/trace-output'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { DaemonRunTransport } from '../main/daemon-run-transport'
import { DaemonRunRuntime } from '../main/daemon-run-runtime'
import { createDaemonRunSurface } from '../main/bootstrap/daemon-run-surface'

afterEach(cleanupTempDirs)


async function until<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined || Date.now() >= deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('daemon native-turn trace (what the session-open bench arms Stop on)', () => {
  it('delivers the stop-immediate run\'s harness/init event to the window under its run id', async () => {
    const daemon = await startTestDaemon()
    const transport = new DaemonRunTransport((request) => daemon.request(request))
    const delivered: TraceEvent[] = []
    const runtime = new DaemonRunRuntime({
      transport, waitMs: 500,
      send: (channel, payload) => { if (channel === 'agent:trace') delivered.push(...(payload as TraceBatch).events) }
    })
    const surface = createDaemonRunSurface({ transport, runtime, currentCwd: () => daemon.workspace })
    const start = (prompt: string, extra: Record<string, unknown> = {}) => surface.start({
      prompt, providerId: 'codex', cwd: daemon.workspace, commandId: randomUUID(), ...extra
    })
    try {
      const first = await start(`native composer complete ${randomUUID().slice(0, 8)}`)
      expect(await until(() => runtime.runView(first.runId)?.done === true ? true : undefined, 10_000)).toBe(true)
      const session = runtime.runView(first.runId)?.externalSessionId
      expect(session).toBeTruthy()

      const prompt = `native composer stop-immediate ${randomUUID().slice(0, 8)}`
      const held = await start(prompt, { expectedExternalSessionId: session })
      const init = await until(() => delivered.find((event) => event.runId === held.runId && event.kind === 'harness' && event.stage === 'init'), 10_000)
      expect(init?.text).toBe(`Awaiting native turn: ${prompt}`)
      expect(runtime.runView(held.runId)?.done).not.toBe(true)

      await surface.stop(held.runId)
      expect(await until(() => runtime.runView(held.runId)?.done === true ? true : undefined, 10_000)).toBe(true)
    } finally {
      runtime.dispose()
      await daemon.dispose()
    }
  }, 60_000)
})
