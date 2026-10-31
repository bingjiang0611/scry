// Report vocabulary and independent reconciliation for the single-cell readers trial (R4).
//
// Nothing here schedules work, calls a client or inspects a peer view: the runner hands over
// its raw run and this file checks the workload's documented contract as literals (item count,
// done, the index-2 result budget, one final stream replacement with the authoritative body,
// the coalesced tail). It deliberately never re-runs the writer it is checking, so a missing
// step cannot self-justify and the fixture does not pay twice for the same algorithm.
//
// Only counts, stages and booleans leave this file. No trace body is ever reported.
import type { WorkloadStep } from './concurrency-trace-workload'
import type { ActiveRun } from '../../src/shared/trace'

export const TRIAL_TASKS = 16
export const TRIAL_LIMITS = [4, 16] as const
export const TRIAL_READERS = [0, 1, 4] as const
export const TRIAL_ITEMS = [1000, 10000] as const

export type TrialLimit = (typeof TRIAL_LIMITS)[number]
export type TrialReaders = (typeof TRIAL_READERS)[number]
export type TrialItems = (typeof TRIAL_ITEMS)[number]

export interface TrialConfig {
  /** Live tasks per wave: the in-flight working set, never the total task count. */
  limit: TrialLimit
  readers: TrialReaders
  /** Item scale of the client lane. 50000 stays a host-only scale case. */
  items: TrialItems
}

export type TrialStage = 'write' | 'counts' | 'read' | 'merge' | 'validation' | 'reconcile' | 'cleanup'

export type Availability<T> = { available: true; value: T } | { available: false; reason: string }
export const available = <T>(value: T): Availability<T> => ({ available: true, value })
export const unavailable = <T>(reason: string): Availability<T> => ({ available: false, reason })

/** Complete JSON visible semantics: the wire only carries JSON, so every value is normalized. */
export const projection = (value: unknown): unknown => {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('projection input must be JSON-serializable')
  return JSON.parse(encoded)
}

export interface SampleSummary {
  samples: number
  totalMs: number
  maxMs: number
}

export const summarize = (samples: readonly number[]): SampleSummary => ({
  samples: samples.length,
  totalMs: samples.reduce((total, value) => total + value, 0),
  maxMs: samples.reduce((max, value) => Math.max(max, value), 0)
})

/** Process CPU inside the host reader windows: a sum of serial, non-overlapping intervals. */
export interface ReadIntervalCpu {
  samples: number
  userMicros: number
  systemMicros: number
}

export interface CpuMicros {
  userMicros: number
  systemMicros: number
}

export interface StepStat {
  step: WorkloadStep
  /** 'incomplete' records a step that stopped early: the partial evidence is kept, not dropped. */
  status: 'completed' | 'incomplete'
  /** Runs written in this step: the wave size, not the cell task count. */
  runs: number
  /** Contract target for this step (documented workload counts), not a measurement. */
  expectedItemsPerRun: number
  /** Observed item count per checked run, in run order; shorter than runs if the check stopped. */
  itemsObserved: number[]
  /** Wall time of the write batch for the whole wave. */
  writerWallMs: number
  /** Process CPU of this fixture during that batch; overlaps nothing else in this step. */
  writerCpu: CpuMicros
  /** Wall time of the oracle construction plus every per-read comparison of this step. */
  validationWallMs: number
  host: {
    requests: number
    logicalPolls: number
    chunkRequests: number
    responseBytes: number
    hostMs: number
    encodeMs: number
    projectionInputItems: number
    readIntervalCpu: Availability<ReadIntervalCpu>
  }
  /** Client calls attempted in this step, including calls that failed. */
  clientAttempts: number
  /** ... of which the client rejected. Attempts minus failures are the successful polls. */
  readFailures: number
  /** Attempted client call time, stopped when traceDelta settled: merge and oracle excluded. */
  clientLatencyMs: Availability<SampleSummary>
  /** First read of a run: a snapshot without any cursor, which says nothing about eviction. */
  snapshotsWithoutCursor: number
  /** Snapshot answered although the peer already had a cursor for this run. */
  resetsWithCursor: number
  oracleChecks: number
}

export interface PeerStat {
  index: number
  /** Successful traceDelta calls: attempts that were not rejected. */
  polls: number
  /** traceDelta calls attempted, including failures. Never retried. */
  attempts: number
  oracleChecks: number
  snapshotsWithoutCursor: number
  resetsWithCursor: number
  /** Time of every attempt, so a failed call still contributes its real observed cost. */
  latencyMs: Availability<SampleSummary>
}

export type TaskOutcome = 'completed' | 'notStarted' | 'startedIncomplete'

/** One row per fixture task, on the single cell clock. No trace content is ever reported. */
export interface TaskRow {
  runId: string
  outcome: TaskOutcome
  /** Dispatch minus the shared enqueue instant: the task's queue wait. Absent if never dispatched. */
  dispatchedAtMs?: number
  /** Terminal minus the shared enqueue instant; present only for verified completed tasks. */
  terminalAtMs?: number
}

export interface TaskSummary {
  /** Always TRIAL_TASKS: the limit changes the wave size, never the task count. */
  total: number
  completed: number
  notStarted: number
  startedIncomplete: number
}

export interface TrialTimings {
  /** Shared performance.now() origin: every task was enqueued at this instant. */
  enqueueMs: number
  /** Tasks enqueued but not dispatched when the first wave started. */
  queueDepthAtDispatch: number
  /** Highest number of dispatched, unfinished fixture tasks. Not a Provider concurrency. */
  maxFixtureInFlightTasks: number
  cellWallMs: number
  /** Process CPU of this fixture process: includes in-process clients and oracle work. */
  cellProcessCpu: CpuMicros
  queueWaitMs: SampleSummary
  dispatchToTerminalMs: SampleSummary
  /** Wall time of each wave batch in dispatch order: the limit changes this shape. */
  waveMs: number[]
}

export interface RunReconciliation {
  runId: string
  items: number
  done: boolean
  earlyToolResultBytes: number
  streamReplacements: number
  leftoverStreamDeltas: number
  tailCoalesced: boolean
  problems: string[]
}

export interface Throughput {
  tasks: number
  /** Successful reads only: an attempt that failed is not counted as throughput. */
  reads: number
  attempts: number
  wallMs: number
  tasksPerSecond: number
  readsPerSecond: number
}

/** Structured cell failure: a real stage plus the step it happened in, when known. */
export interface TrialFailure {
  stage: TrialStage
  message: string
  step?: WorkloadStep
}

/** Absolute instants for one task; the report converts them to the shared cell clock. */
export interface TaskSnapshot {
  runId: string
  outcome: TaskOutcome
  dispatchedAtMs: number | null
  terminalAtMs: number | null
}

export interface PeerSnapshot {
  index: number
  polls: number
  attempts: number
  oracleChecks: number
  snapshotsWithoutCursor: number
  resetsWithCursor: number
  latencies: readonly number[]
}

export interface CellReport {
  tasks: TaskSummary
  taskRows: TaskRow[]
  timings: TrialTimings
  peers: PeerStat[]
  /** Successful reads only. */
  reads: number
  attempts: number
}

// Pure report construction: no clock read, no scheduling and no client call happens here, so the
// runner cannot bend these numbers while it runs. A task only counts as completed when it has
// both a dispatch and a terminal instant; nothing is filled in for a missing measurement.
export function buildCellReport(input: {
  enqueueMs: number
  queueDepthAtDispatch: number
  maxFixtureInFlightTasks: number
  cellWallMs: number
  cellProcessCpu: CpuMicros
  tasks: readonly TaskSnapshot[]
  waveMs: readonly number[]
  peers: readonly PeerSnapshot[]
}): CellReport {
  const verified = input.tasks.filter((task) =>
    task.outcome === 'completed' && task.dispatchedAtMs !== null && task.terminalAtMs !== null)
  return {
    tasks: {
      total: TRIAL_TASKS,
      completed: verified.length,
      notStarted: input.tasks.filter((task) => task.outcome === 'notStarted').length,
      startedIncomplete: input.tasks.filter((task) => task.outcome === 'startedIncomplete').length
    },
    taskRows: input.tasks.map((task) => ({
      runId: task.runId,
      outcome: task.outcome,
      ...(task.dispatchedAtMs === null ? {} : { dispatchedAtMs: task.dispatchedAtMs - input.enqueueMs }),
      ...(task.terminalAtMs === null ? {} : { terminalAtMs: task.terminalAtMs - input.enqueueMs })
    })),
    timings: {
      enqueueMs: input.enqueueMs,
      queueDepthAtDispatch: input.queueDepthAtDispatch,
      maxFixtureInFlightTasks: input.maxFixtureInFlightTasks,
      cellWallMs: input.cellWallMs,
      cellProcessCpu: input.cellProcessCpu,
      queueWaitMs: summarize(input.tasks.flatMap((task) =>
        task.dispatchedAtMs === null ? [] : [task.dispatchedAtMs - input.enqueueMs])),
      dispatchToTerminalMs: summarize(verified.map((task) =>
        task.terminalAtMs === null || task.dispatchedAtMs === null ? 0 : task.terminalAtMs - task.dispatchedAtMs)),
      waveMs: [...input.waveMs]
    },
    peers: input.peers.map((peer) => ({
      index: peer.index,
      polls: peer.polls,
      attempts: peer.attempts,
      oracleChecks: peer.oracleChecks,
      snapshotsWithoutCursor: peer.snapshotsWithoutCursor,
      resetsWithCursor: peer.resetsWithCursor,
      latencyMs: peer.latencies.length > 0
        ? available(summarize(peer.latencies))
        : unavailable('this peer issued no reads')
    })),
    reads: input.peers.reduce((total, peer) => total + peer.polls, 0),
    attempts: input.peers.reduce((total, peer) => total + peer.attempts, 0)
  }
}

export interface TrialMeasured {
  status: 'measured'
  config: TrialConfig
  tasks: TaskSummary
  taskRows: TaskRow[]
  timings: TrialTimings
  peers: PeerStat[]
  steps: StepStat[]
  reconciliation: RunReconciliation[]
  throughput: Throughput
}

export interface TrialIncomplete {
  status: 'incomplete'
  config: TrialConfig
  tasks: TaskSummary
  taskRows: TaskRow[]
  timings: TrialTimings
  peers: PeerStat[]
  steps: StepStat[]
  reconciliation: RunReconciliation[]
  error: TrialFailure
  /** 'incomplete' means the host could not confirm teardown: the report is not complete. */
  cleanup: 'completed' | 'incomplete'
  /** Only present when cleanup failed, so the evidence can be inspected in place. */
  directory?: string
  cleanupFailures?: string[]
}

export type TrialResult = TrialMeasured | TrialIncomplete

// The workload's documented sequence: seed, quiet, append, coalesce, backfill and done all
// leave the seeded count, and replace-stream collapses three deltas into one item body.
export const expectedItemsAfter = (step: WorkloadStep, k: number): number => step === 'replace-stream' ? k - 2 : k

// The workload's documented sequence, pinned as literals: the early result keeps index 2, the
// stream replacement is the final stream item, and the tail is the coalesced tail body.
const EARLY_TOOL_RESULT_INDEX = 2
// The documented backfill target: the early tool_result grows to the live field budget (8 KiB).
const EARLY_TOOL_RESULT_BYTES = 8 * 1024
const STREAM_FINAL_TEXT = 'Streamed reasoning kept once, after three separated deltas.'
const COALESCED_TAIL_TEXT = 'Tail delta starts here and the tail coalesces'

// Every expected identity comes from the documented workload contract plus the run id, never from
// the item under verification: corrupted metadata must fail instead of relocating the expectation.
const earlyToolResultId = (runId: string): string => `wt:${runId}:${EARLY_TOOL_RESULT_INDEX}`
const streamFinalId = (runId: string): string => `wt:${runId}:stream-final`
const streamMessageId = (runId: string): string => `msg:${runId}:stream`
const tailItemId = (runId: string): string => `wt:${runId}:append-1`
const tailMessageId = (runId: string): string => `msg:${runId}:tail`

// Selected by the published flag alone, so a replacement with a corrupted kind or stage is still
// found and reported instead of quietly leaving the expected set.
const isStreamReplacement = (item: { runtimeMetadata?: Record<string, unknown> }): boolean =>
  item.runtimeMetadata?.replacesStreamedText === true

// Fixed-contract reconciliation. It never rebuilds the run with the writer, so the expected
// values cannot follow a bug in the code path being verified.
export function reconcileRun(raw: ActiveRun, k: number): RunReconciliation {
  const problems: string[] = []
  if (raw.items.length !== k) problems.push(`item count is ${raw.items.length}, contract is ${k}`)
  if (!raw.done) problems.push('run is not done after the done step')

  const early = raw.items[EARLY_TOOL_RESULT_INDEX]
  const earlyBytes = Buffer.byteLength(early?.output ?? '')
  if (early?.id !== earlyToolResultId(raw.runId)) problems.push(`item ${EARLY_TOOL_RESULT_INDEX} is not the early tool result`)
  if (early?.kind !== 'tool' || early?.stage !== 'tool_result') problems.push(`item ${EARLY_TOOL_RESULT_INDEX} is not a tool result event`)
  if (earlyBytes !== EARLY_TOOL_RESULT_BYTES) problems.push(`early tool result is ${earlyBytes} bytes, contract is ${EARLY_TOOL_RESULT_BYTES}`)

  const replacements = raw.items.filter(isStreamReplacement)
  if (replacements.length !== 1) problems.push(`${replacements.length} stream replacements, contract is 1`)
  const replacement = replacements[0]
  if (replacement) {
    if (replacement.id !== streamFinalId(raw.runId)) problems.push('the stream replacement is not the final stream item')
    if (replacement.kind !== 'model') problems.push('the stream replacement is not a model item')
    if (replacement.stage !== 'text') problems.push('the stream replacement is not a completed text item')
    if (replacement.messageId !== streamMessageId(raw.runId)) problems.push('the stream replacement is not on the stream message')
    if (replacement.text !== STREAM_FINAL_TEXT) problems.push('the stream replacement body is not the authoritative text')
  }
  // Counted against the contract message id, so a replacement that lost its own messageId cannot
  // make surviving deltas invisible to this check.
  const leftovers = raw.items.filter((item) =>
    item.kind === 'model' && item.stage === 'text_delta' && item.messageId === streamMessageId(raw.runId)).length
  if (leftovers !== 0) problems.push(`${leftovers} streamed deltas survived the replacement`)

  const tail = raw.items.at(-1)
  const tailCoalesced = (tail?.text ?? '') === COALESCED_TAIL_TEXT
  if (!tailCoalesced) problems.push('the tail body is not the coalesced tail text')
  if (tail?.id !== tailItemId(raw.runId)) problems.push('the tail item is not the coalesced tail delta')
  if (tail?.kind !== 'model' || tail?.stage !== 'text_delta') problems.push('the tail item is not a model text delta')
  if (tail?.messageId !== tailMessageId(raw.runId)) problems.push('the tail item is not on the tail message')

  return {
    runId: raw.runId,
    items: raw.items.length,
    done: raw.done,
    earlyToolResultBytes: earlyBytes,
    streamReplacements: replacements.length,
    leftoverStreamDeltas: leftovers,
    tailCoalesced,
    problems
  }
}
