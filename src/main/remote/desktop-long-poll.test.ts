import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { setup, ssh, statusSnapshot } from './desktop-client-fixtures'
import { requestOn, withPairedHost } from './desktop-host-fixtures'
import { LiveWatchers } from './host-controller-watch'
import { setPerformanceRecordingSink } from '../performance-timing'
import type { PerformanceSample } from '../performance-timing'

describe('long polling instead of ticking', () => {
  it('reuses projected run status and keeps the status lane within six idle requests per minute', async () => {
    const calls: Record<string, unknown>[] = []
    const parked = new Promise<never>(() => {})
    const fixture = await setup({ subscribeResponse: request => {
      calls.push(request)
      return request.known ? parked : statusSnapshot(fixture.host.hostId)
    } })
    try {
      const pending = await fixture.client.pair({ label: 'Idle', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const runId = '22222222-2222-4222-8222-222222222222'
      await expect(fixture.client.runStatus(id, runId)).resolves.toEqual({ state: 'unknown', changed: true })
      await expect.poll(() => calls.length).toBe(2)
      expect(calls[0]).toMatchObject({ op: 'subscribe', waitMs: 0, views: ['sessions', 'activeRuns'] })
      expect(calls[1]).toHaveProperty('known.seq', 1)
      expect(Number(calls[1].waitMs)).toBeGreaterThanOrEqual(15_000)
      for (let attempt = 0; attempt < 6; attempt++) {
        await expect(fixture.client.runStatus(id, runId)).resolves.toEqual({ state: 'unknown', changed: false })
      }
      expect(calls).toHaveLength(2)
      expect(Math.ceil(60_000 / Number(calls[1].waitMs)) + 2).toBeLessThanOrEqual(6)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rejects liveRuns before starting a retired status wait', async () => {
    await withPairedHost(async ({ lanes, endpoint }) => {
      await expect(requestOn(lanes, 'status', 'c1', { endpoint, request: { op: 'liveRuns', waitMs: 20_000 }, replayable: true }))
        .resolves.toEqual({ error: 'unknown_op' })
    })
  })

  it('hands a changed Mac run set to a waiting device within a second', async () => {
    const runs: Array<Record<string, unknown>> = []
    let onChange = () => {}
    const watchers = new LiveWatchers({
      authorizeDevice: () => {},
      authorizedCwd: (cwd: string) => cwd,
      ledger: {} as never,
      gateway: {} as never,
      interactions: { list: () => [] } as never,
      stops: new Map(),
      live: new Map(),
      macRuns: { list: () => runs as never, stop: () => true, answer: () => true,
        subscribe: listener => { onChange = listener; return () => { onChange = () => {} } } },
      poll: () => ({ cursor: 0, minCursor: 0, events: [] }) as never,
      pendingQuestions: () => [],
      runOutput: async () => { throw new Error('lifecycle watch must not read output') },
      runOutputWake: async () => { throw new Error('lifecycle watch must not read output') }
    })
    const first = await watchers.liveRuns('peer', { waitMs: 0 })
    expect(first.runs).toEqual([])
    const started = Date.now()
    const held = watchers.liveRuns('peer', { waitMs: 5_000, revision: first.revision })
    setTimeout(() => {
      runs.push({ runId: 'run-abc-1', providerId: 'pi', cwd: '/workspace', prompt: 'p', questions: [] })
      onChange()
    }, 50)
    const answered = await held
    watchers.close()
    expect(Date.now() - started).toBeLessThanOrEqual(1_100)
    expect(answered.runs).toHaveLength(1)
    expect(answered.revision).not.toBe(first.revision)
  })

  it('wakes on content without sending it when the caller only asked to know', async () => {
    let readText = 0
    const watchers = new LiveWatchers({
      authorizeDevice: () => {},
      authorizedCwd: (cwd: string) => cwd,
      ledger: { runState: () => 'dispatched' } as never,
      gateway: {} as never,
      interactions: { list: () => [] } as never,
      stops: new Map(),
      live: new Map(),
      poll: () => ({ cursor: 3, events: [] }) as never,
      pendingQuestions: () => [],
      runOutput: async () => { readText++; return { chunks: [{ seq: 4, at: 1, runId: 'run-abc-1', kind: 'output' as const, text: 'secret body' }], cursor: 4 } },
      runOutputWake: async () => ({ count: 1, cursor: 4 })
    })
    const reply = await watchers.watchRun('peer', { runId: 'run-abc-1', cursor: 0, outputCursor: 3, waitMs: 0, output: 'wake' })
    // The count travels; the text does not, and the spool is never read for it.
    expect(reply.output).toEqual({ chunks: [], cursor: 4, count: 1 })
    expect(readText).toBe(0)
    expect(JSON.stringify(reply)).not.toContain('secret body')
  })

  it('refuses a retired lifecycle watch without reading or returning output', async () => {
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    try {
      await withPairedHost(async ({ lanes, endpoint }) => {
        const response = await requestOn(lanes, 'watch', 'c1', { endpoint, request: { op: 'watch', runId: '11111111-1111-4111-8111-111111111111', cursor: 0, outputCursor: 0, waitMs: 0, output: false }, replayable: true })
        // Lifecycle only: the reply never carries an output page, so an output-cache
        // fault cannot appear here at all.
        expect(response).toEqual({ error: 'unknown_op' })
      })
      expect(JSON.stringify(samples)).not.toContain('11111111')
    } finally { setPerformanceRecordingSink(null) }
  })
})
