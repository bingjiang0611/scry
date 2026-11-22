import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { announceRun } from './daemon-run-subscription.fixtures'

describe('subscriber binds concurrent daemon runs', () => {
  it('binds all thirty-one starts in one workspace without a per-run poll', async () => {
    const runIds = Array.from({ length: 31 }, () => randomUUID())
    const readIds: unknown[] = []
    const request = vi.fn(async (payload: Record<string, unknown>) => {
      if (payload.op === 'submit') {
        const index = Number(payload.intentId)
        return { runId: runIds[index], status: 'recorded', seq: index + 1 }
      }
      if (payload.op === 'desktop') {
        readIds.push((payload.query as { runId: string }).runId)
        return { desktop: { kind: 'trace', run: null } }
      }
      throw new Error(`unexpected op ${String(payload.op)}`)
    })
    const runtime = new DaemonRunRuntime({ transport: new DaemonRunTransport(request), send: () => undefined })
    const context = { cwd: '/w', providerId: 'codex' }
    const starts = runIds.map((_, index) => runtime.start({ intentId: String(index), detail: '{}', context }))
    await vi.waitFor(() => expect(runIds.every((id) => runtime.isTracking(id))).toBe(true), { interval: 1 })
    const canonical = runIds.map((_, index) => `remote-run-abc-${index}`)
    await Promise.all(runIds.map((id, index) => announceRun(runtime, id, { scryRunId: canonical[index] })))
    expect((await Promise.all(starts)).map(({ runId, bound }) => ({ runId, bound })))
      .toEqual(canonical.map((runId) => ({ runId, bound: true })))
    expect(readIds).toEqual(canonical)
    expect(request.mock.calls.map(([payload]) => payload.op)).toEqual([
      ...runIds.map(() => 'submit'), ...runIds.map(() => 'desktop')
    ])
    runtime.dispose()
  })

  it('follows a pre-recorded send using its subscription binding', async () => {
    const runId = randomUUID()
    const transport = new DaemonRunTransport(async (payload) => {
      if (payload.op !== 'desktop') throw new Error(`unexpected op ${String(payload.op)}`)
      return { desktop: { kind: 'trace', run: null } }
    })
    const runtime = new DaemonRunRuntime({ transport, send: () => undefined })
    const followed = runtime.follow({ runId })
    await announceRun(runtime, runId, { scryRunId: 'remote-run-abc-0' })
    await expect(followed).resolves.toEqual({ runId: 'remote-run-abc-0', bound: true })
    runtime.dispose()
  })
})
