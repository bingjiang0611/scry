// Measurement-only single-cell trial for the remote readers lane (R4).
//
// Scenario, stated once: this is a synthetic protocol reader sweep. Every step writes the same
// work to the whole wave, then each peer sweeps every run of the wave through the real
// DesktopRemoteClient, the real host reader and the production mergeRemoteTrace. It is not the
// daily RemoteChat polling pattern, not a real Provider run and not CPU parallelism: reads are
// deliberately serial, so host reader intervals never overlap.
//
// The verified workload and host fixtures are reused as they are; there is no second transport.
// The contract is fixed (16 tasks, limit 4/16, readers 0/1/4, client items 1000/10000) and an
// invalid config is rejected before any directory or host exists. The raw map keeps every run,
// including finished ones, until the cell ends: nothing is rebuilt per wave.
//
// A step that stops early keeps its partial evidence (observed counts, attempt counters, host
// stat deltas) and is marked incomplete; a task is counted complete only after its run passed
// the fixed-contract reconciliation of its wave.
import { performance } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'
import { sanitizeToolEvents } from '../../src/core/turn-recorder/tool-content'
import { mergeRemoteTrace, type RemoteTraceView } from '../../src/renderer/remote-trace'
import type { ActiveRun } from '../../src/shared/trace'
import type { DesktopRemoteTraceRead, DesktopTraceCursor } from '../../src/shared/desktop-remote'
import { createTraceHost, type TraceHostPeer, type TraceHostStats } from './concurrency-trace-host'
import { WORKLOAD_CWD, WORKLOAD_STEPS, applyWorkloadStep, createWorkloadRun, type WorkloadStep } from './concurrency-trace-workload'
import {
  TRIAL_ITEMS, TRIAL_LIMITS, TRIAL_READERS, TRIAL_TASKS, available, buildCellReport, expectedItemsAfter,
  projection, reconcileRun, summarize, unavailable,
  type Availability, type CpuMicros, type ReadIntervalCpu, type RunReconciliation, type StepStat,
  type TaskSnapshot, type TrialConfig, type TrialFailure, type TrialResult, type TrialStage
} from './concurrency-trace-trial-report'

const LIVE_POLICY = { toolOutput: 'full' as const, toolContentFieldBytes: 8 * 1024, toolContentTurnBytes: 128 * 1024 }
const CONTEXT = { providerId: 'claude' as const, cwd: WORKLOAD_CWD }

type TaskState = 'queued' | 'running' | 'completed'

interface TrialTask {
  runId: string
  state: TaskState
  dispatchedAtMs: number | null
  terminalAtMs: number | null
}

interface TrialPeer {
  peer: TraceHostPeer
  index: number
  /** Per-peer run state: cursors and views are never shared between peers. */
  views: Map<string, RemoteTraceView>
  polls: number
  attempts: number
  oracleChecks: number
  snapshotsWithoutCursor: number
  resetsWithCursor: number
  latencies: number[]
}

// A failure this fixture raised on purpose: it carries the real stage instead of relying on a
// cast, so an unexpected exception can never be reported with an undefined stage.
class StageFailure extends Error {
  readonly stage: TrialStage
  readonly step: WorkloadStep | undefined

  constructor(stage: TrialStage, message: string, step?: WorkloadStep) {
    super(message)
    this.name = 'StageFailure'
    this.stage = stage
    this.step = step
  }
}

function fail(stage: TrialStage, message: string, step?: WorkloadStep): never {
  throw new StageFailure(stage, message, step)
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

interface ReadCounters {
  attempts: number
  failures: number
}

// One attempted read at the smallest honest granularity: the attempt is counted and its duration is
// recorded even when the call is rejected, a rejection fails the cell at the read stage with the
// real error, and nothing is retried.
async function attemptRead(input: {
  peer: TrialPeer
  runId: string
  step: WorkloadStep
  cursor: DesktopTraceCursor | undefined
  latencies: number[]
  counters: ReadCounters
}): Promise<DesktopRemoteTraceRead> {
  const startMs = performance.now()
  input.peer.attempts += 1
  input.counters.attempts += 1
  try {
    return await input.peer.peer.client.traceDelta(input.peer.peer.connectionId, CONTEXT, input.runId, input.cursor)
  } catch (error) {
    input.counters.failures += 1
    throw new StageFailure('read', `traceDelta failed for ${input.runId}: ${errorMessage(error)}`, input.step)
  } finally {
    // Attempted call time: merge, oracle and post-processing are excluded, and a rejected call
    // still contributes the cost it really spent.
    const latencyMs = performance.now() - startMs
    input.latencies.push(latencyMs)
    input.peer.latencies.push(latencyMs)
  }
}

// Same independent contract as the accepted host component: the raw run bounded by the real
// sanitizer, normalized through JSON and declaring the empty attachment list this fixture has
// (the client always reports one), so the comparison is complete visible semantics rather than
// a subset of fields.
const boundedOracle = (run: ActiveRun): unknown => projection({
  ...run,
  attachments: [],
  items: sanitizeToolEvents(run.items, LIVE_POLICY, 'live_renderer')
})

export function assertTrialConfig(config: TrialConfig): void {
  if (!(TRIAL_LIMITS as readonly number[]).includes(config.limit)) throw new Error(`invalid trial config: limit must be 4 or 16, got ${String(config.limit)}`)
  if (!(TRIAL_READERS as readonly number[]).includes(config.readers)) throw new Error(`invalid trial config: readers must be 0, 1 or 4, got ${String(config.readers)}`)
  if (!(TRIAL_ITEMS as readonly number[]).includes(config.items)) throw new Error(`invalid trial config: client lane accepts 1000 or 10000 items, got ${String(config.items)}; 50000 stays a host-only scale case`)
}

export async function runConcurrencyTraceTrial(config: TrialConfig): Promise<TrialResult> {
  assertTrialConfig(config)
  const k = config.items
  const runs = new Map<string, ActiveRun>()
  const host = await createTraceHost({ runs, readers: config.readers })
  const peers: TrialPeer[] = host.peers.map((peer, index) => ({
    peer, index, views: new Map(), polls: 0, attempts: 0, oracleChecks: 0,
    snapshotsWithoutCursor: 0, resetsWithCursor: 0, latencies: []
  }))
  // Real MAC_RUN_ID shape (run-<segment>-<segment>): the production client validator must accept
  // these ids without being relaxed.
  const tasks: TrialTask[] = Array.from({ length: TRIAL_TASKS }, (_, index) => ({
    runId: `run-trial-${index}`, state: 'queued' as TaskState, dispatchedAtMs: null, terminalAtMs: null
  }))
  const steps: StepStat[] = []
  const waveMs: number[] = []
  const reconciliation: RunReconciliation[] = []
  let failure: TrialFailure | null = null
  let maxInFlight = 0
  let queueDepthAtDispatch = 0
  // Phase context for an unexpected error: the reported stage is always the real one.
  let currentStage: TrialStage = 'write'
  let currentStep: WorkloadStep | undefined

  host.resetStats()
  let previousStats = host.stats()
  // One enqueue instant for all 16 tasks; every later wait is measured against this clock.
  const enqueueMs = performance.now()
  const cpuStart = process.cpuUsage()

  try {
    for (let start = 0; start < TRIAL_TASKS; start += config.limit) {
      const wave = tasks.slice(start, start + config.limit)
      const dispatchMs = performance.now()
      for (const task of wave) {
        runs.set(task.runId, createWorkloadRun({ runId: task.runId, k }))
        task.state = 'running'
        task.dispatchedAtMs = dispatchMs
      }
      maxInFlight = Math.max(maxInFlight, wave.length)
      if (start === 0) queueDepthAtDispatch = tasks.filter((task) => task.state === 'queued').length

      for (const step of WORKLOAD_STEPS) {
        currentStep = step
        const expected = expectedItemsAfter(step, k)
        const itemsObserved: number[] = []
        let writerWallMs = 0
        let writerCpu: CpuMicros = { userMicros: 0, systemMicros: 0 }
        let validationWallMs = 0
        let snapshotsWithoutCursor = 0
        let resetsWithCursor = 0
        let oracleChecks = 0
        const stepReads: ReadCounters = { attempts: 0, failures: 0 }
        const latencies: number[] = []
        let completedStep = false
        try {
          currentStage = 'write'
          const writerStartMs = performance.now()
          const writerCpuStart = process.cpuUsage()
          try {
            for (const task of wave) applyWorkloadStep(runs.get(task.runId)!, step, k)
          } finally {
            // A writer that stopped half way still spent real time and CPU, and the runs it never
            // reached are observable as the empty runs they are: 0 is a measurement here.
            writerWallMs = performance.now() - writerStartMs
            const writerUsage = process.cpuUsage(writerCpuStart)
            writerCpu = { userMicros: writerUsage.user, systemMicros: writerUsage.system }
            itemsObserved.push(...wave.map((task) => runs.get(task.runId)!.items.length))
          }

          // Independent count contract, verified after the capture: it reads the observed counts, so
          // it cannot fill in the target for a write that never happened.
          currentStage = 'counts'
          for (const [waveIndex, task] of wave.entries()) {
            const observed = itemsObserved[waveIndex]
            if (observed !== expected) fail('counts', `step ${step} left ${observed} items on ${task.runId}, contract is ${expected}`, step)
          }

          // Oracles exist only for peers that can consume them: a cell with no reader must not pay
          // for projections nobody reads. Projection is validation work, so its duration belongs to
          // validationWallMs and not to the writer or the host.
          const oracles: unknown[] = []
          if (peers.length > 0) {
            currentStage = 'validation'
            const oracleStartMs = performance.now()
            try {
              for (const task of wave) oracles.push(boundedOracle(runs.get(task.runId)!))
            } finally {
              validationWallMs += performance.now() - oracleStartMs
            }
          }

          // Fixed peer order, then fixed run order, one awaited read at a time.
          for (const peer of peers) for (const [waveIndex, task] of wave.entries()) {
            const view = peer.views.get(task.runId) ?? null
            currentStage = 'read'
            const read = await attemptRead({ peer, runId: task.runId, step, cursor: view?.cursor, latencies, counters: stepReads })
            peer.polls++
            if (read.kind === 'snapshot') {
              // A first read has no cursor at all, which is not evidence of eviction.
              if (view?.cursor) { peer.resetsWithCursor++; resetsWithCursor++ }
              else { peer.snapshotsWithoutCursor++; snapshotsWithoutCursor++ }
            }

            currentStage = 'merge'
            const merged = mergeRemoteTrace(view, read)
            if (merged.kind !== 'applied' || !merged.view) fail('merge', `mergeRemoteTrace answered ${merged.kind} for ${task.runId}`, step)
            peer.views.set(task.runId, merged.view)

            currentStage = 'validation'
            const compareStartMs = performance.now()
            try {
              if (!isDeepStrictEqual(merged.view.run, oracles[waveIndex])) {
                fail('validation', `delivered run ${task.runId} differs from the bounded oracle after step ${step}`, step)
              }
            } finally {
              // A failed comparison is real validation cost; it must not vanish from the total.
              validationWallMs += performance.now() - compareStartMs
            }
            peer.oracleChecks++
            oracleChecks++
          }
          completedStep = true
        } finally {
          // Partial work is evidence: a step that stopped early still reports the counts it
          // observed, the calls it attempted and the host deltas it produced.
          const stats = host.stats()
          const delta = (key: keyof TraceHostStats): number => stats[key] - previousStats[key]
          const readSamples = delta('hostReadSamples')
          const readerPeers = peers.length
          const readIntervalCpu: Availability<ReadIntervalCpu> = readSamples > 0
            ? available({ samples: readSamples, userMicros: delta('hostReadUserMicros'), systemMicros: delta('hostReadSystemMicros') })
            : unavailable(readerPeers === 0
              ? 'no reader peers in this cell: the host served no trace read'
              : 'no host read sample was observed in this step: it stopped before any host read')
          steps.push({
            step,
            status: completedStep ? 'completed' : 'incomplete',
            runs: wave.length,
            expectedItemsPerRun: expected,
            itemsObserved,
            writerWallMs,
            // Writer and validation windows are disjoint inside one step, and both sit inside the
            // cell-wide process CPU. Nothing here is added up as a host-only total.
            writerCpu,
            validationWallMs,
            host: {
              requests: delta('requests'),
              logicalPolls: delta('logicalPolls'),
              chunkRequests: delta('chunkRequests'),
              responseBytes: delta('responseBytes'),
              hostMs: delta('hostMs'),
              encodeMs: delta('encodeMs'),
              projectionInputItems: delta('projectionInputItems'),
              readIntervalCpu
            },
            clientAttempts: stepReads.attempts,
            readFailures: stepReads.failures,
            clientLatencyMs: latencies.length > 0
              ? available(summarize(latencies))
              : unavailable(readerPeers === 0
                ? 'no reader peers in this cell: no client call existed to time'
                : 'no client call was observed in this step: it stopped before the read phase'),
            snapshotsWithoutCursor,
            resetsWithCursor,
            oracleChecks
          })
          previousStats = stats
        }
      }

      // Fixed-contract verification of every run of this wave before any of its tasks is counted
      // complete, so a terminal time always covers the final verification work.
      currentStage = 'reconcile'
      for (const task of wave) {
        const run = runs.get(task.runId)
        if (!run) fail('reconcile', `run ${task.runId} is missing from the retained raw map`)
        const result = reconcileRun(run, k)
        if (result.problems.length > 0) fail('reconcile', `${task.runId}: ${result.problems.join('; ')}`)
        reconciliation.push(result)
      }
      currentStep = undefined

      const terminalMs = performance.now()
      waveMs.push(terminalMs - dispatchMs)
      for (const task of wave) {
        task.state = 'completed'
        task.terminalAtMs = terminalMs
      }
    }
  } catch (error) {
    failure = error instanceof StageFailure
      ? { stage: error.stage, message: error.message, ...(error.step === undefined ? {} : { step: error.step }) }
      : { stage: currentStage, message: errorMessage(error), ...(currentStep === undefined ? {} : { step: currentStep }) }
  }

  const cellWallMs = performance.now() - enqueueMs
  const cellCpu = process.cpuUsage(cpuStart)

  // Exactly one dispose for the whole cell. The host fixture memoizes it and reports a teardown
  // it could not confirm as an error, so an unknown cleanup can never look like a clean one.
  const cleanupFailures: string[] = []
  try {
    await host.dispose()
  } catch (error) {
    cleanupFailures.push(...(error instanceof AggregateError
      ? error.errors.map((item: unknown) => errorMessage(item))
      : [errorMessage(error)]))
  }

  // Pure construction lives in the report module: this file only hands over what it observed.
  const report = buildCellReport({
    enqueueMs,
    queueDepthAtDispatch,
    maxFixtureInFlightTasks: maxInFlight,
    cellWallMs,
    // Fixture process CPU: in-process clients and oracle work are inside this number.
    cellProcessCpu: { userMicros: cellCpu.user, systemMicros: cellCpu.system },
    tasks: tasks.map((task): TaskSnapshot => ({
      runId: task.runId,
      outcome: task.state === 'completed' ? 'completed' : task.state === 'running' ? 'startedIncomplete' : 'notStarted',
      dispatchedAtMs: task.dispatchedAtMs,
      terminalAtMs: task.state === 'completed' ? task.terminalAtMs : null
    })),
    waveMs,
    peers
  })
  const base = {
    config, tasks: report.tasks, taskRows: report.taskRows, timings: report.timings,
    peers: report.peers, steps, reconciliation
  }

  if (failure === null && cleanupFailures.length === 0) {
    const seconds = cellWallMs / 1000
    return {
      status: 'measured',
      ...base,
      // Fixture throughput: in-process clients, JSON transport and oracle checks are included,
      // and only successful reads count as reads. It is not production throughput and says
      // nothing about a real App or Provider.
      throughput: {
        tasks: TRIAL_TASKS,
        reads: report.reads,
        attempts: report.attempts,
        wallMs: cellWallMs,
        tasksPerSecond: TRIAL_TASKS / seconds,
        readsPerSecond: report.reads / seconds
      }
    }
  }
  return {
    status: 'incomplete',
    ...base,
    error: failure ?? { stage: 'cleanup', message: 'host cleanup failed after a complete cell' },
    cleanup: cleanupFailures.length === 0 ? 'completed' : 'incomplete',
    ...(cleanupFailures.length === 0 ? {} : { directory: host.directory, cleanupFailures })
  }
}
