// Shared single-run main projection/revision sample for the concurrency trace lanes.
//
// Moved here from scripts/performance-counters/concurrency-trace-main.counters.test.ts so the work-counter
// collector and the 50k Electron timing entry drive the same seven steps and the same oracle. The sequence is
// fixed: for each of the seven workload stages one bounded projection plus revision observe, one real JSON
// round trip, one merge, and one comparison against an independent literal-policy oracle. Nothing here is
// configurable beyond the item count and the one fixed negative control, so a shorter or reordered sample
// cannot pass as this workload.
//
// Phase attribution is the caller's: `observe(phase, step, operation)` is a synchronous wrapper. The five
// phases are separate operations, so per-phase timing cannot hide serialize, merge or oracle work inside the
// reader. The counter collector maps the last three onto its original `other` bucket.
import { isDeepStrictEqual } from 'node:util'
import { createTraceRuntime } from '../../src/main/bootstrap/trace-runtime'
import { sanitizeToolEvents } from '../../src/core/turn-recorder/tool-content'
import { DockBadgeState } from '../../src/main/dock-badge'
import { createTraceRevisions } from '../../src/main/remote/desktop-trace-delta'
import { mergeRemoteTrace, type RemoteTraceView } from '../../src/renderer/remote-trace'
import type { DesktopRemoteTraceRead, DesktopTraceCursor } from '../../src/shared/desktop-remote'
import type { ActiveRun } from '../../src/shared/trace'
import { applyWorkloadStep, createWorkloadRun, WORKLOAD_STEPS, type WorkloadStep } from './concurrency-trace-workload'

// Literal reader policy of this component: independent of the production constant under test, so the oracle
// cannot inherit a projection bug. `sanitizeToolEvents` is the real sanitizer, called with these literals.
export const MAIN_TRIAL_POLICY = { toolOutput: 'full' as const, toolContentFieldBytes: 8 * 1024, toolContentTurnBytes: 128 * 1024 }

/** Every mismatch between a delivered view and the independent oracle starts with this prefix. */
export const ORACLE_MISMATCH_PREFIX = 'delivered run differs from the independent literal-policy oracle'

export type MainTrialPhase = 'writer' | 'reader' | 'serialize' | 'merge' | 'oracle'

/** Synchronous phase wrapper: `writer` = workload step, `reader` = projection+observe, the rest = one operation each. */
export type MainTrialObserver = <T>(phase: MainTrialPhase, step: WorkloadStep, operation: () => T) => T

export type MainTrialNegativeControl = 'corrupt-body'

/** Fixed negative-control evidence: `rejected` is only ever set when the oracle itself refused the injected body. */
export interface MainTrialControlFacts {
  kind: MainTrialNegativeControl
  step: WorkloadStep
  rejected: true
  oracleError: string
}

// One monotonically increasing id source: the runtime only labels events with it, and nothing measured reads it.
let eventSeq = 0

export const projection = (value: unknown): unknown => {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('projection input must be JSON-serializable')
  return JSON.parse(encoded)
}

// The reader never holds the writer's live objects: one JSON round trip before merge.
export const transmit = (envelope: DesktopRemoteTraceRead): DesktopRemoteTraceRead => projection(envelope) as DesktopRemoteTraceRead

/** Bounded runtime with no window and no renderer: this component measures main-side projection only. */
export function createBoundedRuntime({ nextEventId }: { nextEventId: (prefix: string, runId: string) => string }) {
  return createTraceRuntime({
    getWindow: () => null,
    rendererCanReceive: () => false,
    activeRunSessionKey: () => null,
    dockBadge: new DockBadgeState(() => {}),
    mainEventId: nextEventId
  })
}

// Fixed item counts after each write stage: replace-stream folds three items into one (-2), append adds them
// back, and the remaining stages keep the count. Asserted per stage so a shortened workload cannot pass.
export const stageItemCounts = (k: number): readonly number[] => [k, k, k - 2, k, k, k, k]

/** Independent oracle: the RAW run bounded by the literal policy above, never the projection under test. */
export const oracleRun = (run: ActiveRun): unknown => projection({
  ...run,
  items: sanitizeToolEvents(run.items, MAIN_TRIAL_POLICY, 'live_renderer')
})

export function assertMatchesOracle(delivered: ActiveRun, raw: ActiveRun, label: string): void {
  if (!isDeepStrictEqual(delivered, oracleRun(raw))) {
    throw new Error(`${ORACLE_MISMATCH_PREFIX} after ${label}`)
  }
}

/**
 * The one fixed negative control: flip a byte inside a delivered tool body while keeping the UTF-8 byte
 * length, then require the independent oracle to reject the result. Only the oracle's own mismatch error is
 * counted as a rejection; any other error means the control could not be applied and is rethrown, and an
 * accepted corruption is a harness failure rather than a passing control.
 */
function corruptBodyRejection(delivered: ActiveRun, raw: ActiveRun, step: WorkloadStep): MainTrialControlFacts {
  const corrupted = structuredClone(delivered) as ActiveRun
  const target = corrupted.items.find((item) => {
    const output = (item as { output?: unknown }).output
    return typeof output === 'string' && Buffer.byteLength(output, 'utf8') > 8
  }) as { output: string } | undefined
  if (!target) throw new Error(`the delivered view after ${step} has no tool body to corrupt, so the control cannot be applied`)
  const original = target.output
  const flipped = `${original.slice(0, 2)}${original[2] === 'x' ? 'y' : 'x'}${original.slice(3)}`
  if (Buffer.byteLength(flipped, 'utf8') !== Buffer.byteLength(original, 'utf8')) {
    throw new Error('the corrupted body changed byte length, so it is not a same-byte control')
  }
  target.output = flipped
  try {
    assertMatchesOracle(corrupted, raw, `negative control (corrupt-body) after ${step}`)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith(ORACLE_MISMATCH_PREFIX)) throw error
    return { kind: 'corrupt-body', step, rejected: true, oracleError: error.message }
  }
  throw new Error('corrupt_body_not_rejected: the independent oracle accepted a same-byte body corruption')
}

export interface MainTrialStepFacts {
  step: WorkloadStep
  reply: 'snapshot' | 'delta'
  itemCount: number
  cursorCount: number
  changes: number
}

/** Scalar facts only: the delivered run itself never leaves this module. */
export interface MainTrialFacts {
  runId: string
  k: number
  steps: MainTrialStepFacts[]
  finalItemCount: number
  observes: number
  merges: number
  oracle: 'checked'
  control: MainTrialControlFacts | null
}

export function runMainTrialSample({ k, runId, observe, negativeControl = null }: {
  k: number
  runId: string
  observe: MainTrialObserver
  negativeControl?: MainTrialNegativeControl | null
}): MainTrialFacts {
  const runtime = createBoundedRuntime({ nextEventId: (prefix, id) => `${prefix}:${id}:${++eventSeq}` })
  const revisions = createTraceRevisions()
  const run = createWorkloadRun({ runId, k })
  const expectedCounts = stageItemCounts(k)
  if (expectedCounts.length !== WORKLOAD_STEPS.length) {
    throw new Error('the stage count contract does not cover every workload step')
  }
  const control: { value: MainTrialControlFacts | null } = { value: null }
  let view: RemoteTraceView | null = null
  let cursor: DesktopTraceCursor | undefined
  const steps: MainTrialStepFacts[] = []
  let observes = 0
  let merges = 0
  for (const [index, step] of WORKLOAD_STEPS.entries()) {
    observe('writer', step, () => applyWorkloadStep(run, step, k))
    // The reader window covers exactly the original two operations; the object destructuring stays outside it.
    const read = observe('reader', step, () => {
      const bounded = runtime.boundedLiveRun(run)
      return { bounded, answer: revisions.observe(run.runId, bounded.items, cursor) }
    })
    const { bounded, answer } = read
    const { items, ...meta } = bounded
    observes += 1
    const reply: MainTrialStepFacts['reply'] = answer.reset ? 'snapshot' : 'delta'
    const changeIndices: readonly number[] = answer.reset ? [] : answer.changes
    const nextCursor: DesktopTraceCursor = { revision: answer.revision, count: answer.reset ? items.length : answer.count }
    const base = cursor
    let envelope: DesktopRemoteTraceRead
    if (answer.reset) {
      envelope = observe('serialize', step, () => transmit({ kind: 'snapshot', run: bounded, cursor: nextCursor }))
    } else {
      if (!base) throw new Error(`a delta arrived before any snapshot after ${step}`)
      envelope = observe('serialize', step, () => transmit({
        kind: 'delta', run: meta, base: base.revision, cursor: nextCursor,
        changes: changeIndices.map((index) => ({ index, item: items[index] }))
      }))
    }
    const merged = observe('merge', step, () => mergeRemoteTrace(view, envelope))
    merges += 1
    if (merged.kind !== 'applied' || !merged.view) throw new Error(`read did not apply after ${step}`)
    const mergedView: RemoteTraceView = merged.view
    view = mergedView
    cursor = mergedView.cursor
    if (mergedView.run.items.length !== expectedCounts[index]) {
      throw new Error(`delivered ${mergedView.run.items.length} items after ${step}, expected ${expectedCounts[index]}`)
    }
    const delivered = mergedView.run
    observe('oracle', step, () => {
      assertMatchesOracle(delivered, run, step)
      if (negativeControl === 'corrupt-body' && control.value === null) {
        control.value = corruptBodyRejection(delivered, run, step)
      }
    })
    if (mergedView.cursor?.count !== delivered.items.length) {
      throw new Error(`cursor count disagrees with the delivered items after ${step}`)
    }
    steps.push({
      step,
      reply,
      itemCount: delivered.items.length,
      cursorCount: mergedView.cursor?.count ?? -1,
      changes: changeIndices.length
    })
  }
  const finalItemCount = view?.run.items.length ?? 0
  if (finalItemCount !== expectedCounts[expectedCounts.length - 1]) {
    throw new Error(`final item count ${finalItemCount} differs from the stage contract`)
  }
  return { runId, k, steps, finalItemCount, observes, merges, oracle: 'checked', control: control.value }
}
