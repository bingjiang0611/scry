import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { setup, ssh, statusSnapshot } from './desktop-client-fixtures'
import { requestOn, withPairedHost } from './desktop-host-fixtures'
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

  it('refuses a retired lifecycle watch without reading or returning output', async () => {
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    try {
      await withPairedHost(async ({ lanes, endpoint }) => {
        const response = await requestOn(lanes, 'watch', 'c1', { endpoint, request: { op: 'watch', runId: '11111111-1111-4111-8111-111111111111', cursor: 0, outputCursor: 0, waitMs: 0, output: false }, replayable: true })
        // The retired watch operation returns only unknown_op, with no output page.
        expect(response).toEqual({ error: 'unknown_op' })
      })
      expect(JSON.stringify(samples)).not.toContain('11111111')
    } finally { setPerformanceRecordingSink(null) }
  })
})
