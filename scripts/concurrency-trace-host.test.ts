import { rm, stat } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { sanitizeToolEvents } from '../src/core/turn-recorder/tool-content'
import { mergeRemoteTrace, type RemoteTraceView } from '../src/renderer/remote-trace'
import type { ActiveRun } from '../src/shared/trace'
import { createTraceHost, type TraceHost } from './fixtures/concurrency-trace-host'
import { applyWorkloadStep, createWorkloadRun, WORKLOAD_CWD, WORKLOAD_STEPS } from './fixtures/concurrency-trace-workload'

// The real live policy (8 KiB field / 128 KiB turn) as a literal, so the oracle does
// not borrow the fixture's own projection.
const LIVE_POLICY = { toolOutput: 'full' as const, toolContentFieldBytes: 8 * 1024, toolContentTurnBytes: 128 * 1024 }
const CONTEXT = { providerId: 'claude' as const, cwd: WORKLOAD_CWD }
const OUTSIDE_CONTEXT = { providerId: 'claude' as const, cwd: '/outside-fixture' }

async function withHost(readers: 0 | 1 | 4, runs: Map<string, ActiveRun>, body: (host: TraceHost) => Promise<void>): Promise<void> {
  const host = await createTraceHost({ runs, readers })
  try { await body(host) } finally { await host.dispose() }
}

const seeded = (runId: string, k = 24): ActiveRun => {
  const run = createWorkloadRun({ runId, k })
  applyWorkloadStep(run, 'seed', k)
  return run
}

// Full visible semantics of what the peer receives: the wire only carries JSON, so every
// value is normalized through a JSON round trip (which drops keys holding undefined and
// nothing else). The deep comparison below is structural, so object key order is irrelevant
// while array order, bodies, inputs and every metadata/reference field still count.
const projection = (value: unknown): unknown => {
  const encoded = JSON.stringify(value)
  // Callers only pass defined runs and item lists; a non-serializable input is a bug here,
  // not something to paper over with a null placeholder.
  if (encoded === undefined) throw new Error('projection input must be JSON-serializable')
  return JSON.parse(encoded)
}

// Independent oracle for a whole run: the raw run plus the real bounded projection of its
// items. runtime.boundedLiveRun is deliberately not used, so the fixture cannot compare
// itself with itself. These runs carry no attachments, so the empty list the peer reports
// is the expected value.
const oracleRun = (run: ActiveRun): unknown => projection({
  ...run,
  attachments: [],
  items: sanitizeToolEvents(run.items, LIVE_POLICY, 'live_renderer')
})

const applied = (view: RemoteTraceView | null, read: Parameters<typeof mergeRemoteTrace>[1]): { view: RemoteTraceView; changed: boolean } => {
  const merged = mergeRemoteTrace(view, read)
  if (merged.kind !== 'applied' || !merged.view) throw new Error(`read did not apply: ${JSON.stringify(merged.kind)}`)
  return { view: merged.view, changed: merged.changed }
}

describe('concurrency trace host component', () => {
  it('keeps writing with zero readers and defines no read cost', async () => {
    const runs = new Map<string, ActiveRun>()
    const run = createWorkloadRun({ runId: 'run-wk-a', k: 24 })
    runs.set(run.runId, run)
    await withHost(0, runs, async (host) => {
      expect(host.peers).toHaveLength(0)
      for (const step of WORKLOAD_STEPS) applyWorkloadStep(run, step, 24)
      // Every write still happened; there is no reader to pay for.
      expect(run.items).toHaveLength(24)
      expect(run.done).toBe(true)
      const stats = host.stats()
      expect(stats.requests).toBe(0)
      expect(stats.traceRequests).toBe(0)
      // No read happened, so there is no latency sample at all. This is "undefined",
      // not "zero milliseconds": nothing here may be reported as a 0 ms read.
      expect(stats.projectionCalls).toBe(0)
      expect(stats.responseBytes).toBe(0)
      expect(stats.logicalPolls).toBe(0)
      expect(stats.hostReadSamples).toBe(0)
    })
  })

  // k=512 is above the live turn budget, so the same real host/client path also carries the
  // bounded suffix, not only small payloads.
  it('merges every fixed step from real host reads and matches the whole bounded run', async () => {
    const runs = new Map<string, ActiveRun>()
    const K = 512
    const run = createWorkloadRun({ runId: 'run-wk-a', k: K })
    runs.set(run.runId, run)
    await withHost(1, runs, async (host) => {
      const peer = host.peers[0]
      let view: RemoteTraceView | null = null
      let itemsBeforeDone: unknown | null = null
      for (const step of WORKLOAD_STEPS) {
        if (step === 'done') itemsBeforeDone = projection(view!.run.items)
        applyWorkloadStep(run, step, K)
        const read = await peer.client.traceDelta(peer.connectionId, CONTEXT, run.runId, view?.cursor)
        if (step === 'quiet') {
          // A real delta with no changes: still a delta, not a reset.
          expect(read.kind).toBe('delta')
          if (read.kind === 'delta') expect(read.changes).toEqual([])
        }
        const merged = applied(view, read)
        view = merged.view
        // Whole-run oracle: metadata plus every item body, not just item count or byte sizes.
        expect(projection(view.run)).toEqual(oracleRun(run))
        if (step === 'quiet') expect(merged.changed).toBe(false)
        if (step === 'done') {
          // done is metadata only: the peer sees a change, the items do not move.
          expect(merged.changed).toBe(true)
          expect(projection(view.run.items)).toEqual(itemsBeforeDone)
          expect(view.run.done).toBe(true)
        }
      }
      expect(view!.run.done).toBe(true)
      // The peer holds decoded copies, never the host's objects.
      const peerItem = view!.run.items[1]
      const hostText = run.items[1].text
      ;(peerItem as { text?: string }).text = 'mutated-by-peer'
      expect(run.items[1].text).toBe(hostText)
    })
  })

  it('shares one revision between peers and resets only after a controlled read sequence', async () => {
    const runs = new Map<string, ActiveRun>()
    const target = seeded('run-wk-t')
    runs.set(target.runId, target)
    const others = Array.from({ length: 8 }, (_, index) => {
      const other = seeded(`run-wk-o${index + 1}`)
      runs.set(other.runId, other)
      return other
    })
    await withHost(4, runs, async (host) => {
      const views: RemoteTraceView[] = []
      for (const peer of host.peers) {
        const read = await peer.client.traceDelta(peer.connectionId, CONTEXT, target.runId)
        // A first read is a snapshot because this peer holds no cursor, not because of eviction.
        expect(read.kind).toBe('snapshot')
        views.push(applied(null, read).view)
      }
      expect(new Set(views.map((view) => view.cursor?.revision)).size).toBe(1)

      const peer = host.peers[0]
      const incremental = await peer.client.traceDelta(peer.connectionId, CONTEXT, target.runId, views[0].cursor)
      expect(incremental.kind).toBe('delta')

      // Eight other runs through the same reader push the target out of MAX_RUNS=8.
      for (const other of others) await host.peers[1].client.traceDelta(host.peers[1].connectionId, CONTEXT, other.runId)

      const second = views[0].cursor
      const reset = await peer.client.traceDelta(peer.connectionId, CONTEXT, target.runId, second)
      expect(reset.kind).toBe('snapshot')
      const cursor = reset.kind === 'snapshot' ? reset.cursor : undefined
      expect(cursor?.revision).toBeDefined()
      expect(cursor?.revision).not.toBe(second?.revision)

      // done keeps the run readable; only leaving the map does.
      target.done = true
      const readable = await peer.client.traceDelta(peer.connectionId, CONTEXT, target.runId, cursor)
      expect(readable.kind).toBe('delta')
      expect(readable.kind === 'delta' ? readable.run.done : null).toBe(true)

      runs.delete(target.runId)
      expect(await peer.client.traceDelta(peer.connectionId, CONTEXT, target.runId, cursor)).toEqual({ kind: 'snapshot', run: null })

      // Same run id back in the map: a fresh revision, so the old cursor cannot continue.
      runs.set(target.runId, target)
      expect((await peer.client.traceDelta(peer.connectionId, CONTEXT, target.runId, cursor)).kind).toBe('snapshot')
    })
  })

  it('accepts 10000 items and rejects 10001 through the real client cap', async () => {
    const runs = new Map<string, ActiveRun>()
    // Model events only: nothing here exercises the tool budgets, and one short body per
    // item keeps the response well under the 4 MiB transport cap so the client item cap
    // is the only boundary in play.
    const capacity = (runId: string, count: number): ActiveRun => ({
      runId, providerId: 'claude', cwd: WORKLOAD_CWD, userText: 'capacity', done: true,
      items: Array.from({ length: count }, (_, index) => ({
        id: `${runId}:${index}`, ts: new Date(1_800_000_000_000 + index).toISOString(),
        runId, kind: 'model' as const, stage: 'text_delta', messageId: `${runId}:m`, text: 'x'
      }))
    })
    const accepted = capacity('run-wk-c1', 10_000)
    const rejected = capacity('run-wk-c2', 10_001)
    runs.set(accepted.runId, accepted)
    runs.set(rejected.runId, rejected)
    await withHost(1, runs, async (host) => {
      const peer = host.peers[0]
      host.resetStats()
      const ok = await peer.client.traceDelta(peer.connectionId, CONTEXT, accepted.runId)
      expect(ok.kind).toBe('snapshot')
      expect(ok.kind === 'snapshot' ? ok.run?.items.length : -1).toBe(10_000)
      const stats = host.stats()
      expect(stats.logicalPolls).toBe(1)
      // One response, so this is the client item cap rather than a chunked transport path.
      expect(stats.chunkRequests).toBe(0)
      expect(stats.responseBytes).toBeGreaterThan(0)
      await expect(peer.client.traceDelta(peer.connectionId, CONTEXT, rejected.runId)).rejects.toThrow('invalid_trace_response')
      // The rejected read was still one logical poll over one transport response.
      const afterReject = host.stats()
      expect(afterReject.logicalPolls).toBe(2)
      expect(afterReject.chunkRequests).toBe(0)
    })
  })

  // Controlled clock for a rejected read too. process.cpuUsage(previous) already returns a
  // delta, so the mock follows that contract: a bare call answers a cumulative snapshot and a
  // call with the previous snapshot answers this one minus that one. Nothing here asserts that
  // any ms value is positive.
  it('records reader-interval process CPU from cpuUsage deltas, including rejected reads', async () => {
    const runs = new Map<string, ActiveRun>()
    const run = seeded('run-wk-a')
    runs.set(run.runId, run)
    await withHost(1, runs, async (host) => {
      const peer = host.peers[0]
      host.resetStats()
      const firstStart = { user: 1_000, system: 500 }
      const secondStart = { user: 3_000, system: 1_000 }
      const snapshots = [firstStart, { user: 2_500, system: 900 }, secondStart, { user: 3_500, system: 1_200 }]
      const usage = vi.spyOn(process, 'cpuUsage').mockImplementation((previous?: NodeJS.CpuUsage) => {
        const next = snapshots.shift()
        if (!next) throw new Error('cpuUsage was called more often than this mock provides snapshots')
        return previous ? { user: next.user - previous.user, system: next.system - previous.system } : next
      })
      try {
        await peer.client.traceDelta(peer.connectionId, CONTEXT, run.runId)
        let stats = host.stats()
        expect(stats.hostReadSamples).toBe(1)
        expect(stats.hostReadUserMicros).toBe(1_500)
        expect(stats.hostReadSystemMicros).toBe(400)
        // Same scope on the rejection path: the reader threw inside the measured interval.
        await expect(peer.client.traceDelta(peer.connectionId, OUTSIDE_CONTEXT, run.runId)).rejects.toThrow('workspace_not_authorized')
        stats = host.stats()
        expect(stats.hostReadSamples).toBe(2)
        expect(stats.hostReadUserMicros).toBe(2_000)
        expect(stats.hostReadSystemMicros).toBe(600)
        // One snapshot and one delta per read: the implementation must hand its own snapshot
        // back as the previous value instead of asking for a second cumulative reading.
        expect(usage.mock.calls).toEqual([[], [firstStart], [], [secondStart]])
      } finally {
        usage.mockRestore()
      }
    })
  })

  // Regression for the cleanup contract: a client dispose that fails before dispatch
  // leaves the temp directory as the only evidence, and a second dispose must keep
  // reporting the failure instead of turning an unknown cleanup into success.
  it('keeps a failed client dispose visible and leaves the temporary directory in place', async () => {
    const runs = new Map<string, ActiveRun>()
    const run = seeded('run-wk-a')
    runs.set(run.runId, run)
    const host = await createTraceHost({ runs, readers: 1 })
    const peer = host.peers[0]
    // Rejects before dispatch: the real dispose never runs, so nothing is closed by it.
    const spy = vi.spyOn(peer.client, 'dispose').mockRejectedValueOnce(new Error('dispose rejected before dispatch'))
    try {
      await expect(host.dispose()).rejects.toThrow()
      await expect(stat(host.directory)).resolves.toBeDefined()
      await expect(host.dispose()).rejects.toThrow()
      // No retry: an unknown cleanup must not be dispatched a second time.
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      // This client is known-undispatched, so close it for real and drop our own directory.
      await peer.client.dispose()
      await rm(host.directory, { recursive: true, force: true })
    }
  })

  // Negative control for the projection oracle: a body rewritten to the same UTF-8
  // length with unchanged metadata is invisible to length/metadata comparison, so the
  // current projection() reports no difference. A full visible-JSON comparison must.
  it('distinguishes same-length tool body changes that the current oracle cannot', () => {
    const run = createWorkloadRun({ runId: 'run-wk-a', k: 24 })
    applyWorkloadStep(run, 'seed', 24)
    const items = sanitizeToolEvents(run.items, LIVE_POLICY, 'live_renderer')
    const outputIndex = items.findIndex((item) => typeof item.output === 'string' && item.output.length > 0)
    const inputIndex = items.findIndex((item) => item.input !== undefined && typeof item.input === 'object')
    expect(outputIndex).toBeGreaterThanOrEqual(0)
    expect(inputIndex).toBeGreaterThanOrEqual(0)
    const body = items[outputIndex].output as string
    const rewritten = `Z${body.slice(1)}`
    // Same UTF-8 byte length, different content.
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(body))
    expect(rewritten).not.toBe(body)
    // Only the visible body changes in each case; every byte count and metadata field stays put.
    const corruptedOutput = items.map((item, position) => position === outputIndex ? { ...item, output: rewritten } : item)
    const corruptedInput = items.map((item, position) => position === inputIndex ? { ...item, input: { command: 'rg -n "symbol9" src' } } : item)
    expect(corruptedOutput[outputIndex].outputContent).toEqual(items[outputIndex].outputContent)
    expect(corruptedInput[inputIndex].inputContent).toEqual(items[inputIndex].inputContent)
    expect(projection(corruptedOutput)).not.toEqual(projection(items))
    expect(projection(corruptedInput)).not.toEqual(projection(items))
    // The production run is never mutated by this fixture.
    expect(projection(items)).toEqual(projection(sanitizeToolEvents(run.items, LIVE_POLICY, 'live_renderer')))
  })
})
