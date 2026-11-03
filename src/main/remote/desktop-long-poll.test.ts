import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { setup, ssh } from './desktop-client-fixtures'
import { requestOn, withPairedHost } from './desktop-host-fixtures'
import { LiveWatchers } from './host-controller-watch'
import { setPerformanceRecordingSink } from '../performance-timing'
import type { PerformanceSample } from '../performance-timing'

describe('long polling instead of ticking', () => {
  it('costs one request per window, so an idle minute stays under six', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Idle', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const runId = '22222222-2222-4222-8222-222222222222'
      const before = fixture.tlsRequest.mock.calls.length
      // First read answers now, so a caller that has never seen the run is not made
      // to wait a window for an answer it already has.
      await fixture.client.runStatus(id, runId)
      const first = fixture.tlsRequest.mock.calls.slice(before).map(call => (call[0].request as { op?: string; waitMs?: number }))
      expect(first).toHaveLength(1)
      expect(first[0]).toMatchObject({ op: 'watch', waitMs: 0, output: false })
      const beforeSecond = fixture.tlsRequest.mock.calls.length
      await fixture.client.runStatus(id, runId)
      const second = fixture.tlsRequest.mock.calls.slice(beforeSecond).map(call => (call[0].request as { op?: string; waitMs?: number }))
      // Later reads wait on the host: one request per window, not one per second.
      expect(second).toHaveLength(1)
      expect(second[0]).toMatchObject({ op: 'watch', output: false })
      expect(Number(second[0].waitMs)).toBeGreaterThanOrEqual(15_000)
      // Four windows a minute, below the six-request budget with room for a retry.
      expect(Math.ceil(60_000 / Number(second[0].waitMs)) + 2).toBeLessThanOrEqual(6)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('answers at once for a device that has not seen the set, then waits for a change', async () => {
    await withPairedHost(async ({ lanes, endpoint }) => {
      const first = await requestOn(lanes, 'status', 'c1', { endpoint, request: { op: 'liveRuns', waitMs: 0 }, replayable: true }) as { liveRuns: { revision: string; runs: unknown[] } }
      expect(first.liveRuns.runs).toEqual([])
      // Same revision: the host holds the request instead of answering immediately.
      const started = Date.now()
      const held = requestOn(lanes, 'status', 'c1', { endpoint, request: { op: 'liveRuns', waitMs: 400, revision: first.liveRuns.revision }, replayable: false })
      const second = await held as { liveRuns: { revision: string } }
      expect(Date.now() - started).toBeGreaterThanOrEqual(300)
      expect(second.liveRuns.revision).toBe(first.liveRuns.revision)
    })
  })

  it('hands a changed Mac run set to a waiting device within a second', async () => {
    const runs: Array<Record<string, unknown>> = []
    const watchers = new LiveWatchers({
      authorizeDevice: () => {},
      authorizedCwd: (cwd: string) => cwd,
      ledger: {} as never,
      gateway: {} as never,
      interactions: { list: () => [] } as never,
      stops: new Map(),
      live: new Map(),
      macRuns: { list: () => runs as never, stop: () => true, answer: () => true },
      poll: () => ({ cursor: 0, minCursor: 0, events: [] }) as never,
      pendingQuestions: () => [],
      runOutput: async () => { throw new Error('lifecycle watch must not read output') }
    })
    const first = await watchers.liveRuns('peer', { waitMs: 0 })
    expect(first.runs).toEqual([])
    const started = Date.now()
    const held = watchers.liveRuns('peer', { waitMs: 5_000, revision: first.revision })
    // The Mac side starts a run; nothing tells the host controller, so the wait
    // must notice it on its own within the budget.
    setTimeout(() => { runs.push({ runId: 'run-abc-1', providerId: 'pi', cwd: '/workspace', prompt: 'p', questions: [] }) }, 50)
    const answered = await held
    // This mac source has no change signal, so this is the fallback path: one
    // 1000 ms tick plus the change itself. The signal path (`subscribe`) is
    // covered in host-controller-live-runs.test.ts and stays under 1 s.
    expect(Date.now() - started).toBeLessThanOrEqual(1_100)
    expect(answered.runs).toHaveLength(1)
    expect(answered.revision).not.toBe(first.revision)
  })

  it('refuses a lifecycle watch for an unknown run without returning output', async () => {
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    try {
      await withPairedHost(async ({ lanes, endpoint }) => {
        const response = await requestOn(lanes, 'watch', 'c1', { endpoint, request: { op: 'watch', runId: '11111111-1111-4111-8111-111111111111', cursor: 0, outputCursor: 0, waitMs: 0, output: false }, replayable: true })
        // Lifecycle only: the reply never carries an output page, so an output-cache
        // fault cannot appear here at all.
        expect(response).toEqual({ error: 'unknown_run' })
      })
      expect(JSON.stringify(samples)).not.toContain('11111111')
    } finally { setPerformanceRecordingSink(null) }
  })
})
