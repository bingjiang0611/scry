import { describe, expect, it, vi } from 'vitest'
import { DesktopRemoteClientTrace } from '../src/main/remote/desktop-client-trace'
import type { DesktopRemoteTraceRead } from '../src/shared/desktop-remote'
import { runConcurrencyTraceTrial } from './fixtures/concurrency-trace-trial'
import type { TrialConfig, TrialMeasured, TrialResult } from './fixtures/concurrency-trace-trial-report'

// Focused lane at the smallest client scale (1000 items). These cells do run limit 16 (all 16 tasks
// in one wave); the 10000-item cell and the full 4/16 x 0/1/4 matrix belong to the Electron run, and
// 50000 items stays a host-only scale case.
const STEPS = ['seed', 'quiet', 'replace-stream', 'append', 'coalesce', 'backfill', 'done']
const ITEMS = 1000

// Boundary spy on this fixture's host factory: the real factory is still used, and the counter
// only proves whether a cell entered it at all. No injectable platform is added to the fixture.
const hostCreations = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./fixtures/concurrency-trace-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fixtures/concurrency-trace-host')>()
  return {
    ...actual,
    createTraceHost: (input: Parameters<typeof actual.createTraceHost>[0]) => {
      hostCreations.calls += 1
      return actual.createTraceHost(input)
    }
  }
})

// Call-through spy on the real projection: the sanitizer still runs, and the counter proves
// whether a cell built oracles that nobody could read. Also file-wide and call-through.
const sanitizeCalls = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../src/core/turn-recorder/tool-content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/turn-recorder/tool-content')>()
  return {
    ...actual,
    sanitizeToolEvents: (...args: Parameters<typeof actual.sanitizeToolEvents>) => {
      sanitizeCalls.calls += 1
      return actual.sanitizeToolEvents(...args)
    }
  }
})

const measured = (result: TrialResult): TrialMeasured => {
  if (result.status !== 'measured') throw new Error(`trial did not measure: ${result.error.stage}: ${result.error.message}`)
  return result
}

// Deliberately outside the fixed union: the runner has to reject these before any host exists.
const invalid = (config: { limit: number; readers: number; items: number }): TrialConfig => config as unknown as TrialConfig

// traceDelta is declared on this class of the client chain, so the prototype spy intercepts the
// real method every peer instance inherits.
type DeltaCall = DesktopRemoteClientTrace['traceDelta']

// Equal-length corruption: the same byte count with different content, so counts and shapes stay
// identical and only a whole-run content comparison can notice it.
function corruptBody(read: DesktopRemoteTraceRead): DesktopRemoteTraceRead {
  if (read.kind !== 'snapshot' || !read.run) return read
  const target = read.run.items.find((item) => item.kind === 'tool' && typeof item.output === 'string' && item.output.length > 0)
  const body = target?.output
  if (!target || typeof body !== 'string' || body.length === 0) throw new Error('the delivered snapshot had no tool body to corrupt')
  const last = body.at(-1)
  target.output = `${body.slice(0, -1)}${last === 'x' ? 'X' : 'x'}`
  return read
}

// Wraps the real client method, so overlapping reads are observed instead of asserted by the
// fixture's own bookkeeping. No sleeps and no fake transport: the original method is called.
function monitorReads(options: { failAtCall?: number; corruptFirstRead?: boolean } = {}) {
  const original: DeltaCall = DesktopRemoteClientTrace.prototype.traceDelta
  let active = 0
  let maxActive = 0
  let calls = 0
  const spy = vi.spyOn(DesktopRemoteClientTrace.prototype, 'traceDelta').mockImplementation(async function (this: DesktopRemoteClientTrace, ...args: Parameters<DeltaCall>) {
    calls += 1
    const call = calls
    if (options.failAtCall === call) throw new Error('injected read failure')
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      const read = await original.apply(this, args)
      return options.corruptFirstRead === true && call === 1 ? corruptBody(read) : read
    } finally {
      active -= 1
    }
  })
  return {
    restore: (): void => { spy.mockRestore() },
    get calls(): number { return calls },
    get maxActive(): number { return maxActive }
  }
}

describe('concurrency trace trial component', () => {
  it('completes all 16 tasks with the same work volume at limit 4 and limit 16', async () => {
    const monitor = monitorReads()
    try {
      const narrow = measured(await runConcurrencyTraceTrial({ limit: 4, readers: 1, items: ITEMS }))
      const wide = measured(await runConcurrencyTraceTrial({ limit: 16, readers: 1, items: ITEMS }))

      for (const result of [narrow, wide]) {
        expect(result.tasks).toEqual({ total: 16, completed: 16, notStarted: 0, startedIncomplete: 0 })
        expect(result.peers).toHaveLength(1)
        // 16 tasks x 7 steps, unchanged by the wave size.
        expect(result.peers[0].polls).toBe(112)
        expect(result.peers[0].attempts).toBe(112)
        expect(result.peers[0].oracleChecks).toBe(112)
        // Every step completed, and each observed count matches the contract target.
        expect(result.steps.every((step) => step.status === 'completed')).toBe(true)
        expect(result.steps.every((step) => step.readFailures === 0 && step.clientAttempts === step.runs * result.peers.length)).toBe(true)
        expect(result.steps.every((step) => step.itemsObserved.length === step.runs
          && step.itemsObserved.every((count) => count === step.expectedItemsPerRun))).toBe(true)
        // Write volume is the task count per step, not the wave size.
        expect(result.steps.reduce((total, step) => total + step.runs, 0)).toBe(112)
        // One logical poll per run read: chunk continuations are counted apart from polls.
        expect(result.steps.every((step) => step.host.logicalPolls === step.runs * result.peers.length)).toBe(true)
        // Every run starts with a snapshot that had no cursor, so none of these is an eviction.
        expect(result.peers[0].snapshotsWithoutCursor).toBe(16)
        expect(result.reconciliation).toHaveLength(16)
        expect(result.reconciliation.every((run) => run.problems.length === 0)).toBe(true)
        expect(result.reconciliation.every((run) => run.items === ITEMS && run.done)).toBe(true)
        expect(result.reconciliation.every((run) =>
          run.earlyToolResultBytes === 8192 && run.streamReplacements === 1 && run.leftoverStreamDeltas === 0 && run.tailCoalesced)).toBe(true)
        // Every task carries its own dispatch and terminal instant on the shared cell clock.
        expect(result.taskRows.filter((row) => row.outcome === 'completed')).toHaveLength(16)
        expect(result.taskRows.every((row) =>
          (row.dispatchedAtMs ?? -1) >= 0 && (row.terminalAtMs ?? -1) >= (row.dispatchedAtMs ?? -1))).toBe(true)
        expect(result.throughput).toMatchObject({ tasks: 16, reads: 112, attempts: 112 })
      }

      // One recorded step per wave per step: four waves of four, or a single wave of sixteen.
      expect(narrow.steps).toHaveLength(28)
      expect(wide.steps).toHaveLength(7)
      expect(narrow.steps.slice(0, 7).map((step) => step.step)).toEqual(STEPS)
      expect(wide.steps.map((step) => step.step)).toEqual(STEPS)
      expect(narrow.steps.slice(0, 7).map((step) => step.expectedItemsPerRun)).toEqual([1000, 1000, 998, 1000, 1000, 1000, 1000])
      expect(narrow.timings.waveMs).toHaveLength(4)
      expect(wide.timings.waveMs).toHaveLength(1)

      // Causality inside one cell: a later wave only dispatches after the previous wave finished
      // its verification, so no two waves overlap in flight.
      for (let wave = 1; wave < 4; wave++) {
        const previous = narrow.taskRows.slice((wave - 1) * 4, wave * 4)
        const current = narrow.taskRows.slice(wave * 4, (wave + 1) * 4)
        const previousTerminal = Math.max(...previous.map((row) => row.terminalAtMs ?? -1))
        expect(current.every((row) => (row.dispatchedAtMs ?? -1) >= previousTerminal)).toBe(true)
      }
      // The row instants are exactly the cell summary: queue wait is dispatch minus enqueue.
      const dispatchInstants = narrow.taskRows.map((row) => row.dispatchedAtMs ?? -1)
      expect(narrow.timings.queueWaitMs.samples).toBe(16)
      expect(narrow.timings.queueWaitMs.maxMs).toBe(Math.max(...dispatchInstants))
      expect(narrow.timings.queueWaitMs.totalMs).toBeCloseTo(dispatchInstants.reduce((total, value) => total + value, 0), 6)

      // The limit is a working-set boundary: both cells run the same 16 tasks.
      expect(narrow.timings.maxFixtureInFlightTasks).toBe(4)
      expect(wide.timings.maxFixtureInFlightTasks).toBe(16)
      expect(narrow.timings.queueDepthAtDispatch).toBe(12)
      expect(wide.timings.queueDepthAtDispatch).toBe(0)

      // Four live runs stay inside the 8-run revision cache; sixteen do not, so 16 x 7 reads
      // become 16 first reads plus 96 resets instead of silently reusing stale cursors.
      expect(narrow.peers[0].resetsWithCursor).toBe(0)
      expect(wide.peers[0].resetsWithCursor).toBe(96)

      // Reads never overlap: the deepest observed concurrency across both cells is one call.
      expect(monitor.maxActive).toBe(1)
    } finally {
      monitor.restore()
    }
  })

  it('completes every write with zero readers and marks reader metrics unavailable', async () => {
    const before = sanitizeCalls.calls
    const result = measured(await runConcurrencyTraceTrial({ limit: 4, readers: 0, items: ITEMS }))
    // Nobody can read this cell, so no bounded oracle may be built: the baseline must not pay
    // for 112 projections that no peer could ever consume.
    expect(sanitizeCalls.calls).toBe(before)
    expect(result.tasks).toEqual({ total: 16, completed: 16, notStarted: 0, startedIncomplete: 0 })
    expect(result.peers).toEqual([])
    expect(result.throughput.reads).toBe(0)
    expect(result.throughput.attempts).toBe(0)
    // The same fixed step sequence still runs for every wave, with no reader present.
    expect(result.steps.map((step) => step.step)).toEqual([...STEPS, ...STEPS, ...STEPS, ...STEPS])
    for (const step of result.steps) {
      expect(step.status).toBe('completed')
      // Real zero counts stay zero; nothing is invented for the missing reader.
      expect(step.host.logicalPolls).toBe(0)
      expect(step.host.requests).toBe(0)
      expect(step.host.responseBytes).toBe(0)
      expect(step.clientAttempts).toBe(0)
      expect(step.oracleChecks).toBe(0)
      expect(step.snapshotsWithoutCursor).toBe(0)
      expect(step.resetsWithCursor).toBe(0)
      expect(step.itemsObserved).toEqual([step.expectedItemsPerRun, step.expectedItemsPerRun, step.expectedItemsPerRun, step.expectedItemsPerRun])
      const readCpu = step.host.readIntervalCpu
      expect(readCpu.available).toBe(false)
      expect(readCpu.available === false ? readCpu.reason : '').toContain('no reader peers')
      const latency = step.clientLatencyMs
      expect(latency.available).toBe(false)
      expect(latency.available === false ? latency.reason : '').toContain('no reader peers')
    }
    expect(result.reconciliation).toHaveLength(16)
    expect(result.reconciliation.every((run) => run.problems.length === 0)).toBe(true)
  })

  it('covers 112 polls per peer and 448 in total with four readers', async () => {
    const before = sanitizeCalls.calls
    const result = measured(await runConcurrencyTraceTrial({ limit: 4, readers: 4, items: ITEMS }))
    // Live boundary: a cell with peers does project runs, so the zero above is not vacuous.
    expect(sanitizeCalls.calls).toBeGreaterThan(before)
    expect(result.peers.map((peer) => peer.polls)).toEqual([112, 112, 112, 112])
    expect(result.peers.map((peer) => peer.attempts)).toEqual([112, 112, 112, 112])
    expect(result.peers.reduce((total, peer) => total + peer.oracleChecks, 0)).toBe(448)
    // Host logical polls exclude chunk continuations, so they must match the peer totals.
    expect(result.steps.reduce((total, step) => total + step.host.logicalPolls, 0)).toBe(448)
    expect(result.throughput).toMatchObject({ reads: 448, attempts: 448 })
    // Each peer keeps its own cursors: four peers mean four first reads per run.
    for (const peer of result.peers) expect(peer.snapshotsWithoutCursor).toBe(16)
  })

  it('stops a cell on the first read failure without retrying and still disposes the host', async () => {
    const monitor = monitorReads({ failAtCall: 5 })
    let result: TrialResult | undefined
    try {
      result = await runConcurrencyTraceTrial({ limit: 4, readers: 1, items: ITEMS })
    } finally {
      monitor.restore()
    }
    if (!result) throw new Error('the trial returned no result')
    expect(result.status).toBe('incomplete')
    if (result.status !== 'incomplete') throw new Error('unreachable')
    expect(result.error.stage).toBe('read')
    expect(result.error.step).toBe('quiet')
    // Wave one was dispatched, nothing else: no later wave started.
    expect(result.tasks).toEqual({ total: 16, completed: 0, notStarted: 12, startedIncomplete: 4 })
    // The partial evidence of both steps is kept: seed finished, quiet stopped inside its reads.
    expect(result.steps.map((step) => `${step.step}:${step.status}`)).toEqual(['seed:completed', 'quiet:incomplete'])
    expect(result.steps[0].itemsObserved).toEqual([1000, 1000, 1000, 1000])
    expect(result.steps[1].itemsObserved).toEqual([1000, 1000, 1000, 1000])
    expect(result.steps[1].clientAttempts).toBe(1)
    expect(result.steps[1].readFailures).toBe(1)
    expect(result.steps[1].oracleChecks).toBe(0)
    // Only the four reads that reached the host are polls; the failed attempt is not a read.
    expect(result.steps.reduce((total, step) => total + step.host.logicalPolls, 0)).toBe(4)
    expect(result.peers[0].attempts).toBe(5)
    expect(result.peers[0].polls).toBe(4)
    expect(result.peers[0].latencyMs).toMatchObject({ available: true, value: { samples: 5 } })
    expect(result.cleanup).toBe('completed')
    expect(result.directory).toBeUndefined()
    // Dispatched tasks keep their dispatch instant and no terminal time; queued ones have neither.
    expect(result.taskRows.filter((row) => row.outcome === 'startedIncomplete')).toHaveLength(4)
    expect(result.taskRows.filter((row) => row.outcome === 'notStarted')).toHaveLength(12)
    expect(result.taskRows.filter((row) => row.outcome !== 'completed').every((row) => row.terminalAtMs === undefined)).toBe(true)
    expect(result.taskRows.filter((row) => row.outcome === 'notStarted').every((row) => row.dispatchedAtMs === undefined)).toBe(true)
    // One attempt per read: the failed read is not retried.
    expect(monitor.calls).toBe(5)
  })

  it('reports an equal-length body corruption as an incomplete validation', async () => {
    const monitor = monitorReads({ corruptFirstRead: true })
    let result: TrialResult | undefined
    try {
      result = await runConcurrencyTraceTrial({ limit: 4, readers: 1, items: ITEMS })
    } finally {
      monitor.restore()
    }
    if (!result) throw new Error('the trial returned no result')
    expect(result.status).toBe('incomplete')
    if (result.status !== 'incomplete') throw new Error('unreachable')
    // Counts and shapes were untouched, so only the whole-run content check could catch it.
    expect(result.error.stage).toBe('validation')
    expect(result.steps.map((step) => `${step.step}:${step.status}`)).toEqual(['seed:incomplete'])
    expect(result.steps[0].clientAttempts).toBe(1)
    expect(result.steps[0].readFailures).toBe(0)
    expect(result.steps[0].oracleChecks).toBe(0)
    expect(result.peers[0].attempts).toBe(1)
    expect(result.peers[0].polls).toBe(1)
    expect(result.tasks).toEqual({ total: 16, completed: 0, notStarted: 12, startedIncomplete: 4 })
    expect(result.cleanup).toBe('completed')
    expect(monitor.calls).toBe(1)
  })

  it('rejects an invalid config before the host factory is called', async () => {
    // Live boundary first: a real cell does enter the factory, so the check below is not vacuous.
    const before = hostCreations.calls
    measured(await runConcurrencyTraceTrial({ limit: 4, readers: 0, items: ITEMS }))
    expect(hostCreations.calls).toBe(before + 1)
    const afterCell = hostCreations.calls
    await expect(runConcurrencyTraceTrial(invalid({ limit: 8, readers: 1, items: ITEMS }))).rejects.toThrow(/limit must be 4 or 16/)
    await expect(runConcurrencyTraceTrial(invalid({ limit: 4, readers: 2, items: ITEMS }))).rejects.toThrow(/readers must be 0, 1 or 4/)
    await expect(runConcurrencyTraceTrial(invalid({ limit: 4, readers: 1, items: 50000 }))).rejects.toThrow(/50000 stays a host-only scale case/)
    expect(hostCreations.calls).toBe(afterCell)
  })
})
