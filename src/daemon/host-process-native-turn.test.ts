import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { TraceEvent } from '../shared/trace'
import type { TraceBatch } from '../main/trace-output'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { DaemonRunTransport } from '../main/daemon-run-transport'
import { DaemonRunRuntime } from '../main/daemon-run-runtime'
import { startDaemonRunEvents } from '../main/daemon-run-events'
import { createDaemonRunSurface } from '../main/bootstrap/daemon-run-surface'

afterEach(cleanupTempDirs)

// The native session-open bench (scripts/native-composer-probe.mjs) arms its first Stop
// on the fixture's `harness`/`init` event ("Awaiting native turn: <prompt>"), which a
// `native composer stop-immediate` run emits before the Provider names its native turn.
// In daemon mode that event reaches the window only through the daemon's trace and the
// App's own delivery (DaemonRunRuntime -> `agent:trace`). This pins that contract on a
// real daemon, for a run sent into an existing session as the bench does: the event
// arrives on `agent:trace` under the run id the start returned, before the run ends.

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
    const terminalStops = new Map<string, boolean>()
    const runtime = new DaemonRunRuntime({
      transport, send: (channel, payload) => {
        if (channel === 'agent:trace') delivered.push(...(payload as TraceBatch).events)
        if (channel === 'agent:turnDone') {
          const { runId, stopped } = payload as { runId: string; stopped?: boolean }
          terminalStops.set(runId, stopped === true)
        }
      }
    })
    const events = startDaemonRunEvents({ transport, runtime, send: () => undefined, waitMs: 500 })
    const surface = createDaemonRunSurface({ transport, runtime, currentCwd: () => daemon.workspace })
    const start = (prompt: string, extra: Record<string, unknown> = {}) => surface.start({
      prompt, providerId: 'codex', cwd: daemon.workspace, commandId: randomUUID(), ...extra
    })
    // The trace can finish before the host commits its terminal projection.
    // The native composer waits for both the view and the terminal notice.
    const waitForTerminal = (runId: string) =>
      until(() => runtime.runView(runId)?.done === true ? terminalStops.get(runId) : undefined, 10_000)
    try {
      const first = await start(`native composer complete ${randomUUID().slice(0, 8)}`)
      expect(await waitForTerminal(first.runId)).toBe(false)
      const session = runtime.runView(first.runId)?.externalSessionId
      expect(session).toBeTruthy()

      const prompt = `native composer stop-immediate ${randomUUID().slice(0, 8)}`
      const held = await start(prompt, { expectedExternalSessionId: session })
      const init = await until(() => delivered.find((event) => event.runId === held.runId && event.kind === 'harness' && event.stage === 'init'), 10_000)
      expect(init?.text).toBe(`Awaiting native turn: ${prompt}`)
      expect(runtime.runView(held.runId)?.done).not.toBe(true)
      expect(terminalStops.has(held.runId)).toBe(false)

      await surface.stop(held.runId)
      expect(await waitForTerminal(held.runId)).toBe(true)
    } finally {
      events.dispose()
      runtime.dispose()
      await daemon.dispose()
    }
  }, 60_000)
})
