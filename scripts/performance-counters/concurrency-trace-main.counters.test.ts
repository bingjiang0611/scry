import { describe, expect, it } from 'vitest'
import { createTraceRevisions } from '../../src/main/remote/desktop-trace-delta'
import { mergeRemoteTrace, type RemoteTraceView } from '../../src/renderer/remote-trace'
import type { ActiveRun } from '../../src/shared/trace'
import { applyWorkloadStep, createWorkloadRun, WORKLOAD_STEPS } from '../fixtures/concurrency-trace-workload'
import {
  assertMatchesOracle, createBoundedRuntime, runMainTrialSample, stageItemCounts, transmit
} from '../fixtures/concurrency-trace-main-trial'
import {
  buildObservations, defaultRepeats, registerProbeControl, startProbe, totalsMatchPhases, writeCollector,
  type ProbePhase, type ProbeSample
} from './concurrency-trace-probe'

// Single-run main projection/revision component cases at 10k and 50k items. DesktopRemoteClient caps one read
// at 10000 items, so the 50k case is a host-side projection/revision claim and never a client or capability
// claim: no client, no wire transport, no App, no TLS, no Provider and no 16-task cell.
// The single-run sample, its stage contract and its literal-policy oracle live in
// ../fixtures/concurrency-trace-main-trial so the 50k Electron timing entry replays the same work.

let eventSeq = 0
const boundedRuntime = () => createBoundedRuntime({ nextEventId: (prefix, runId) => `${prefix}:${runId}:${++eventSeq}` })

/** One complete single-run sample: 7 write stages, 7 bounded projections, 7 revision reads, 7 merges. */
function runSingleComponent(k: number): ProbeSample {
  let current: ProbePhase = 'other'
  const probe = startProbe(() => current)
  try {
    // The shared sample names five phases; this collector keeps its original three buckets by mapping
    // serialize/merge/oracle onto `other`, so the recorded counts stay comparable with the accepted numbers.
    const facts = runMainTrialSample({
      k,
      runId: `run-main-${k}`,
      observe: (phase, _step, operation) => {
        const previous = current
        current = phase === 'writer' || phase === 'reader' ? phase : 'other'
        try {
          return operation()
        } finally {
          current = previous
        }
      }
    })
    expect(facts.observes).toBe(WORKLOAD_STEPS.length)
    expect(facts.merges).toBe(WORKLOAD_STEPS.length)
    expect(facts.steps.map((step) => step.itemCount)).toEqual(stageItemCounts(k))
    const sample = probe.read()
    expect(totalsMatchPhases(sample)).toBe(true)
    return sample
  } finally {
    probe.stop()
  }
}

// Baseline for the negative controls: a JSON-isolated snapshot of a run written up to the backfill step, plus
// the live run, runtime and revision store it came from, so a later real read can be replayed on the same run.
function baselineView(k: number): {
  view: RemoteTraceView
  run: ActiveRun
  runtime: ReturnType<typeof boundedRuntime>
  revisions: ReturnType<typeof createTraceRevisions>
} {
  const runtime = boundedRuntime()
  const revisions = createTraceRevisions()
  const run = createWorkloadRun({ runId: `run-negative-${k}`, k })
  for (const step of WORKLOAD_STEPS.slice(0, WORKLOAD_STEPS.indexOf('backfill'))) applyWorkloadStep(run, step, k)
  const bounded = runtime.boundedLiveRun(run)
  const answer = revisions.observe(run.runId, bounded.items, undefined)
  if (!answer.reset) throw new Error('the first read must be a snapshot')
  const read = transmit({ kind: 'snapshot', run: bounded, cursor: { revision: answer.revision, count: bounded.items.length } })
  const merged = mergeRemoteTrace(null, read)
  if (merged.kind !== 'applied' || !merged.view) throw new Error('the delivered snapshot did not apply')
  return { view: merged.view, run, runtime, revisions }
}

// The quoted scenario names are the collector selector contract: the standard tool finds a collector by the
// quoted scenario string in its source, so these stay string literals instead of template interpolation.
const CASES: Array<{ k: number, scenario: string }> = [
  { k: 10_000, scenario: 'trace.main-10k' },
  { k: 50_000, scenario: 'trace.main-50k' }
]
const samples = new Map<number, ProbeSample[]>(CASES.map(({ k }) => [k, []]))

describe('concurrency trace single-run main projection work counters', () => {
  registerProbeControl()

  // Discrimination control for the oracle itself: a body corruption that keeps the byte length must be
  // rejected, otherwise an oracle comparing only counts and lengths would look healthy.
  it('rejects a same-byte-length body corruption', () => {
    const baseline = baselineView(1000)
    expect(() => assertMatchesOracle(baseline.view.run, baseline.run, 'baseline')).not.toThrow()
    const corrupted = structuredClone(baseline.view.run) as ActiveRun
    const targetIndex = corrupted.items.findIndex((item) => {
      const output = (item as { output?: unknown }).output
      return typeof output === 'string' && output.length > 8
    })
    if (targetIndex < 0) throw new Error('the workload must contain a tool output body to corrupt')
    const target = corrupted.items[targetIndex] as { output: string }
    const original = target.output
    target.output = `${original.slice(0, 2)}${original[2] === 'x' ? 'y' : 'x'}${original.slice(3)}`
    expect(target.output).toHaveLength(original.length)
    expect(() => assertMatchesOracle(corrupted, baseline.run, 'corrupted body')).toThrow(/independent literal-policy oracle/)
  })

  // The other discrimination control: the real store delivers a delta for a replaced item, and the same delta
  // with its patch dropped keeps the store's revision, count and run metadata, so the merge cannot refuse it.
  // Only the independent oracle can catch the item left stale.
  it('rejects a delta that omits the patch for a replaced item', () => {
    const baseline = baselineView(1000)
    applyWorkloadStep(baseline.run, 'backfill', 1000)
    const bounded = baseline.runtime.boundedLiveRun(baseline.run)
    const answer = baseline.revisions.observe(baseline.run.runId, bounded.items, baseline.view.cursor)
    if (answer.reset) throw new Error('the backfill step must be delivered as a delta')
    const changes = answer.changes
    if (changes.length === 0) throw new Error('the backfill step must deliver at least one patch')
    const { items: boundedItems, ...meta } = bounded
    const base = baseline.view.cursor
    if (!base) throw new Error('the baseline snapshot must carry a cursor')
    const realRead = transmit({
      kind: 'delta', run: meta, base: base.revision,
      cursor: { revision: answer.revision, count: answer.count },
      changes: changes.map((index) => ({ index, item: boundedItems[index] }))
    })
    const applied = mergeRemoteTrace(baseline.view, realRead)
    if (applied.kind !== 'applied' || !applied.view) throw new Error('the real delta must apply to the baseline view')
    // The narrowed view is captured in a local so the callback below keeps the check the guard already made.
    const appliedView = applied.view
    // The healthy delta reproduces the independent oracle, so the control below fails for the missing patch.
    expect(() => assertMatchesOracle(appliedView.run, baseline.run, 'real delta')).not.toThrow()
    const missingPatch = transmit({
      kind: 'delta', run: meta, base: base.revision,
      cursor: { revision: answer.revision, count: answer.count },
      changes: []
    })
    const stale = mergeRemoteTrace(baseline.view, missingPatch)
    if (stale.kind !== 'applied' || !stale.view) throw new Error('the missing-patch delta must reach the oracle, not be refused by the merge')
    const staleView = stale.view
    expect(() => assertMatchesOracle(staleView.run, baseline.run, 'missing patch')).toThrow(/independent literal-policy oracle/)
  })

  it.each(CASES.flatMap(({ k, scenario }) => Array.from({ length: defaultRepeats }, (_, index) => ({ k, scenario, index: index + 1 }))))(
    'counts one complete run at $scenario (repeat $index)',
    ({ k }) => {
      const sample = runSingleComponent(k)
      const collected = samples.get(k)
      if (!collected) throw new Error(`no sample list for ${k}`)
      collected.push(sample)
    }
  )

  it.each(CASES)('aggregates the $scenario samples as unregistered candidates', ({ k, scenario }) => {
    const collected = samples.get(k) ?? []
    expect(collected).toHaveLength(defaultRepeats)
    writeCollector(`concurrency-trace-main-${k / 1000}k`, buildObservations({
      scenario,
      workload: `trace-main-single-run;items=${k};stages=7;observes=7;merges=7;literal-policy-oracle=true`,
      // Stated limits: one run, host-side only, and no native or non-crypto hashing is observed.
      source: 'real boundedLiveRun + createTraceRevisions().observe + JSON round trip + mergeRemoteTrace on one run; counts node:crypto createHash calls, bytes accepted by Hash.update and JSON.stringify UTF-8 output bytes by phase; not a client, 16-task, Provider, TLS or full-App measurement, and native digest internals, subprocesses and other hash APIs are not counted'
    }, collected))
  })
})
