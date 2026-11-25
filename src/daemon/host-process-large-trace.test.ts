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
import { DesktopLanes, laneForRequest } from '../main/remote/desktop-lane'
import { REMOTE_PROTOCOL_VERSION } from '../shared/desktop-remote'

afterEach(cleanupTempDirs)


const SINGLE_RESPONSE_LIMIT = 4 * 1024 * 1024 - 1024
const BLOCK_BYTES = 512 * 1024

async function until<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined || Date.now() >= deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('daemon trace past the single-response limit', () => {
  it('delivers a live run whose trace the daemon answers in chunks', async () => {
    const daemon = await startTestDaemon()
    const lanes = new DesktopLanes()
    const transport = new DaemonRunTransport((request) => daemon.request(request))
    const delivered: TraceEvent[] = []
    const warnings: unknown[] = []
    const runtime = new DaemonRunRuntime({
      transport,  onWarn: (_message, error) => { warnings.push(error) },
      send: (channel, payload) => { if (channel === 'agent:trace') delivered.push(...(payload as TraceBatch).events) }
    })
    const events = startDaemonRunEvents({ transport, runtime, send: () => undefined, waitMs: 500 })
    const surface = createDaemonRunSurface({ transport, runtime, currentCwd: () => daemon.workspace })
    try {
      const run = await surface.start({ prompt: 'performance large trace', providerId: 'codex', cwd: daemon.workspace, commandId: randomUUID() })
      const ready = await until(() => delivered.find((event) => event.runId === run.runId && event.id.endsWith(':large:ready')), 20_000)
      expect(warnings).toEqual([])
      expect(ready?.text).toBe('large trace ready')
      const blocks = delivered.filter((event) => event.runId === run.runId && event.kind === 'model' && event.stage === 'thinking')
      expect(blocks.map((event) => event.thinking?.length)).toEqual(Array.from({ length: 12 }, () => BLOCK_BYTES))
      const view = runtime.runView(run.runId)
      expect(view?.done).not.toBe(true)
      expect(Buffer.byteLength(JSON.stringify(view))).toBeGreaterThan(SINGLE_RESPONSE_LIMIT)

      const desktop = new DaemonRunTransport((request, options) => lanes.request(laneForRequest(request), 'reopen', {
        endpoint: daemon.endpoint, request: { protocol: REMOTE_PROTOCOL_VERSION, ...request }, replayable: options?.replayable ?? false
      }))
      const reopened = await createDaemonRunSurface({ transport: desktop, runtime, currentCwd: () => daemon.workspace }).adopt(run.runId)
      expect(reopened).toMatchObject({ runId: run.runId, userText: 'performance large trace', done: false })
      expect(reopened?.items.filter(event => event.stage === 'thinking').map(event => event.thinking?.length))
        .toEqual(Array.from({ length: 12 }, () => BLOCK_BYTES))

      await surface.stop(run.runId)
      expect(await until(() => runtime.runView(run.runId)?.done === true ? true : undefined, 20_000)).toBe(true)
    } finally {
      events.dispose()
      lanes.closeAll()
      runtime.dispose()
      await daemon.dispose()
    }
  }, 90_000)
})
