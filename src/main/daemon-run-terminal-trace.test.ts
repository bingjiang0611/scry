import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { TraceEvent } from '../shared/trace'
import type { TraceBatch } from './trace-output'
import { cleanupTempDirs } from '../daemon/host-process.fixtures'
import { startTestDaemon } from '../daemon/host-process.harness'
import { DaemonRunTransport } from './daemon-run-transport'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { createDaemonRunSurface } from './bootstrap/daemon-run-surface'
import { startDaemonRunEvents } from './daemon-run-events'

afterEach(cleanupTempDirs)


async function until<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined || Date.now() >= deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('daemon run trace after the run settles', () => {
  it('delivers every event the run wrote, through its final result, when the App reads after finalization', async () => {
    const daemon = await startTestDaemon()
    const transport = new DaemonRunTransport(async (request) => {
      const query = request.query as Record<string, unknown> | undefined
      if (request.op === 'desktop' && query?.kind === 'trace') await new Promise((resolve) => setTimeout(resolve, 250))
      return await daemon.request(request)
    })
    const delivered: TraceEvent[] = []
    const runtime = new DaemonRunRuntime({
      transport,
      send: (channel, payload) => { if (channel === 'agent:trace') delivered.push(...(payload as TraceBatch).events) }
    })
    const surface = createDaemonRunSurface({ transport, runtime, currentCwd: () => daemon.workspace })
    const events = startDaemonRunEvents({ transport, runtime, send: () => undefined })
    try {
      const run = await surface.start({ prompt: 'terminal trace', providerId: 'codex', cwd: daemon.workspace, commandId: randomUUID() })
      expect(await until(() => runtime.runView(run.runId)?.done === true ? true : undefined, 10_000)).toBe(true)

      const history = await daemon.request({ op: 'desktop', query: {
        kind: 'history', context: { cwd: daemon.workspace, providerId: 'codex', externalSessionId: `smoke-session-${run.runId}` }
      } })
      const turn = (history.desktop?.history?.turns as Array<{ runId: string; items: TraceEvent[] }> | undefined)?.find((item) => item.runId === run.runId)
      const written = turn?.items.map((event) => event.id) ?? []
      expect(written).toContain(`${run.runId}:result`)

      const mine = () => delivered.filter((event) => event.runId === run.runId)
      await expect.poll(() => mine().map((event) => event.id), { timeout: 2_000 }).toEqual(written)
      expect(mine().find((event) => event.kind === 'harness' && event.stage === 'result')).toMatchObject({ tokensIn: 12, tokensOut: 4 })

      const context = { cwd: daemon.workspace, providerId: 'codex', externalSessionId: `smoke-session-${run.runId}` }
      const query = { kind: 'trace', context, runId: run.runId }
      await expect.poll(async () => (await daemon.request({ op: 'desktop', query })).desktop?.run, { timeout: 5_000 })
        .toBeNull()
      await expect(daemon.request({ op: 'desktop', query: { ...query, settledTail: true } }))
        .resolves.toEqual({ error: 'invalid_request' })
      const archive = await transport.archivedRunTrace({ context, runId: run.runId })
      expect(archive?.items.map((event) => event.id)).toEqual(written)
    } finally {
      events.dispose()
      runtime.dispose()
      await daemon.dispose()
    }
  }, 60_000)
})
