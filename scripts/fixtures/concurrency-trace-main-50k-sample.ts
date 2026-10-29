// Timed single-sample runner for the 50k main-only trial, plus the pure assembly of its report.
//
// No Electron import here: this module only drives the shared seven-step sample with a timing observer and
// turns the collected evidence into a report, so the failure path (partial phases, original failure location,
// after-memory) can be tested without starting an App. The Electron entry adds process runtime facts and paths.
//
// Phase attribution is explicit: five named phases (writer, reader, serialize, merge, oracle) per step, at most
// 7x5 scalar records. Each phase record is a cumulative delta of separate, non-overlapping operations, so the
// phases are summed exactly once into phaseSum; that sum is reported beside overall and never added to it.
// `overall`, `phaseSum` and `unobservedMs` are therefore three separate numbers, and unobservedMs (overall minus
// phaseSum) is not an isolated observer cost: it also holds sample work done outside any observed operation,
// and every window carries the fixed cost of its own clock reads and the observer's bookkeeping.
import { WORKLOAD_STEPS, type WorkloadStep } from './concurrency-trace-workload'
import {
  runMainTrialSample, stageItemCounts,
  type MainTrialControlFacts, type MainTrialFacts, type MainTrialNegativeControl, type MainTrialObserver, type MainTrialPhase
} from './concurrency-trace-main-trial'

export const MAIN_50K_FIXED_ITEMS = 50_000
export const MAIN_50K_RUN_ID = 'run-main-50k'
export const MAIN_50K_STAGE_COUNTS = stageItemCounts(MAIN_50K_FIXED_ITEMS)

export const PHASE_ORDER: readonly MainTrialPhase[] = ['writer', 'reader', 'serialize', 'merge', 'oracle']

export interface PhaseSample {
  step: WorkloadStep
  phase: MainTrialPhase
  calls: number
  wallMs: number
  cpuUserUs: number
  cpuSystemUs: number
}

export interface CpuWall {
  wallMs: number
  cpuUserUs: number
  cpuSystemUs: number
}

export interface MemorySample {
  rssKb: number
  heapUsedKb: number
  heapTotalKb: number
  externalKb: number
}

export interface SampleFailure {
  /** The observed phase, or null when the failure happened outside any observed operation. */
  phase: MainTrialPhase | null
  step: WorkloadStep | null
  error: string
}

export const MEMORY_SCOPE = 'before/after process.memoryUsage() of this Electron main process; the after value is taken before the report is assembled or written, so it includes the sample and its oracle but not report assembly or write, and it is not a peak and not a post-GC residency'

export const SAMPLE_BOUNDARY = {
  measured: 'wall = performance.now() and cpu = process.cpuUsage() around each observed operation; overall covers one seven-step single-run sample only. Every window includes the fixed cost of its own clock reads and the observer bookkeeping, so these are elapsed and CPU deltas of a window, not pure algorithm time',
  excluded: 'process start, Electron readiness, path setup, report assembly, report write and notification are outside every measured window',
  phases: 'five phases per step, cumulative deltas of separate non-overlapping operations; the phases are summed once into phaseSum beside overall and never added to it, and unobservedMs is overall minus phaseSum, which mixes the wrapper\'s own clock reads with sample work done outside any observed operation'
} as const

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const memoryNow = (): MemorySample => {
  const usage = process.memoryUsage()
  return { rssKb: Math.round(usage.rss / 1024), heapUsedKb: Math.round(usage.heapUsed / 1024), heapTotalKb: Math.round(usage.heapTotal / 1024), externalKb: Math.round(usage.external / 1024) }
}

export interface Measurement {
  facts: MainTrialFacts | null
  failure: SampleFailure | null
  phases: PhaseSample[]
  overall: CpuWall
  memory: { before: MemorySample, after: MemorySample }
}

/** One fixed sample at k=50000. A thrown step keeps every phase record collected before it. */
export function runTimedSample({ negativeControl = null }: { negativeControl?: MainTrialNegativeControl | null } = {}): Measurement {
  const collected = new Map<string, PhaseSample>()
  // The failing operation is captured inside the observer: its finally block runs before this function's catch
  // sees the error, so a marker written afterwards would always be empty.
  const failureRef: { value: SampleFailure | null } = { value: null }
  const observe: MainTrialObserver = <T,>(phase: MainTrialPhase, step: WorkloadStep, operation: () => T): T => {
    const wallStart = performance.now()
    const cpuStart = process.cpuUsage()
    try {
      return operation()
    } catch (error) {
      if (failureRef.value === null) failureRef.value = { phase, step, error: describe(error) }
      throw error
    } finally {
      const cpu = process.cpuUsage(cpuStart)
      const key = `${step}:${phase}`
      const entry = collected.get(key) ?? { step, phase, calls: 0, wallMs: 0, cpuUserUs: 0, cpuSystemUs: 0 }
      entry.calls += 1
      entry.wallMs += performance.now() - wallStart
      entry.cpuUserUs += cpu.user
      entry.cpuSystemUs += cpu.system
      collected.set(key, entry)
    }
  }
  const memoryBefore = memoryNow()
  const wallStart = performance.now()
  const cpuStart = process.cpuUsage()
  let facts: MainTrialFacts | null = null
  let failure: SampleFailure | null = null
  try {
    facts = runMainTrialSample({ k: MAIN_50K_FIXED_ITEMS, runId: MAIN_50K_RUN_ID, observe, negativeControl })
  } catch (error) {
    // A failure outside every observed operation keeps null phase/step instead of borrowing the last one.
    failure = failureRef.value ?? { phase: null, step: null, error: describe(error) }
  }
  const cpu = process.cpuUsage(cpuStart)
  const overall = { wallMs: performance.now() - wallStart, cpuUserUs: cpu.user, cpuSystemUs: cpu.system }
  const memoryAfter = memoryNow()
  const order = (sample: PhaseSample): number => WORKLOAD_STEPS.indexOf(sample.step) * PHASE_ORDER.length + PHASE_ORDER.indexOf(sample.phase)
  const phases = [...collected.values()].sort((left, right) => order(left) - order(right))
  return { facts, failure, phases, overall, memory: { before: memoryBefore, after: memoryAfter } }
}

export interface TrialReport {
  schema: 1
  status: 'measured' | 'failed'
  k: number
  runId: string
  controlRequested: MainTrialNegativeControl | null
  controlApplied: MainTrialControlFacts | null
  facts: MainTrialFacts | null
  phases: PhaseSample[]
  phaseSum: CpuWall
  overall: CpuWall
  unobservedMs: number
  memory: { before: MemorySample, after: MemorySample, scope: string }
  failure: SampleFailure | null
  boundary: typeof SAMPLE_BOUNDARY
}

/**
 * The report's status is derived from evidence, never from what was hoped for: a requested control always
 * yields a failed status, a control that never ran yields a failure instead of a fabricated rejection, and a
 * measured status is only reachable with complete step facts and no failure.
 */
export function assembleReport({ controlRequested, measurement }: {
  controlRequested: MainTrialNegativeControl | null
  measurement: Measurement
}): TrialReport {
  const applied = measurement.facts?.control ?? null
  const injected = (control: MainTrialControlFacts): SampleFailure => ({
    phase: 'oracle',
    step: control.step,
    error: `injected corrupt-body control: the independent oracle rejected it (${control.oracleError})`
  })
  let failure: SampleFailure | null = measurement.failure
  if (failure === null && controlRequested !== null) {
    failure = applied === null
      ? { phase: null, step: null, error: `the ${controlRequested} control was requested but never applied, so it proved nothing` }
      : injected(applied)
  }
  const phaseSum = measurement.phases.reduce<CpuWall>((total, sample) => ({
    wallMs: total.wallMs + sample.wallMs,
    cpuUserUs: total.cpuUserUs + sample.cpuUserUs,
    cpuSystemUs: total.cpuSystemUs + sample.cpuSystemUs
  }), { wallMs: 0, cpuUserUs: 0, cpuSystemUs: 0 })
  return {
    schema: 1,
    status: failure === null ? 'measured' : 'failed',
    k: MAIN_50K_FIXED_ITEMS,
    runId: MAIN_50K_RUN_ID,
    controlRequested,
    controlApplied: applied,
    facts: measurement.facts,
    phases: measurement.phases,
    phaseSum,
    overall: measurement.overall,
    unobservedMs: measurement.overall.wallMs - phaseSum.wallMs,
    memory: { ...measurement.memory, scope: MEMORY_SCOPE },
    failure,
    boundary: SAMPLE_BOUNDARY
  }
}
