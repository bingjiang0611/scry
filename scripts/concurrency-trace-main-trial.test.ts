import { describe, expect, it } from 'vitest'
import type { ActiveRun } from '../src/shared/trace'
import { applyWorkloadStep, createWorkloadRun, WORKLOAD_STEPS } from './fixtures/concurrency-trace-workload'
import {
  ORACLE_MISMATCH_PREFIX, assertMatchesOracle, createBoundedRuntime, oracleRun, runMainTrialSample, stageItemCounts, transmit,
  type MainTrialPhase
} from './fixtures/concurrency-trace-main-trial'
import { createTraceRevisions } from '../src/main/remote/desktop-trace-delta'
import { mergeRemoteTrace } from '../src/renderer/remote-trace'

describe('main single-run trial sample', () => {
  it('runs the seven steps at 50k and checks every step against the independent oracle', () => {
    const facts = runMainTrialSample({ k: 50_000, runId: 'run-trial-50k', observe: (_phase, _step, operation) => operation() })
    expect(facts.steps.map((step) => step.step)).toEqual([...WORKLOAD_STEPS])
    expect(facts.steps.map((step) => step.itemCount)).toEqual(stageItemCounts(50_000))
    expect(facts.finalItemCount).toBe(50_000)
    expect(facts.observes).toBe(7)
    expect(facts.merges).toBe(7)
    expect(facts.oracle).toBe('checked')
    expect(facts.control).toBeNull()
    // The third read (replace-stream) is a second snapshot, not an expected delta: at 50k the tracked changed
    // indices cross MAX_TRACKED_CHANGES (src/main/remote/desktop-trace-delta.ts:15), so the store trims the
    // oldest revision (:47) and the client's base revision is gone, which the contract answers with a reset
    // (:57). That is an accepted re-snapshot, so it must not be read as a dropped patch.
    expect(facts.steps.map((step) => step.reply)).toEqual(['snapshot', 'delta', 'snapshot', 'delta', 'delta', 'delta', 'delta'])
    expect(facts.steps.reduce((total, step) => total + step.changes, 0)).toBeGreaterThan(0)
    // Cursor and items agree on every step, including the re-snapshot one.
    expect(facts.steps.every((step) => step.cursorCount === step.itemCount)).toBe(true)
    expect(facts.steps[2].changes).toBe(0)
  })

  it('keeps serialize, merge and oracle outside the reader window and names every step', () => {
    // Attribution, not timing: one writer, one reader and three separate operations per step. Folding the
    // merge, the serialization or the oracle into the reader would change this pattern, so a probe would
    // silently credit that work to the reader.
    const seen: Array<{ phase: MainTrialPhase, step: string }> = []
    runMainTrialSample({
      k: 1000,
      runId: 'run-trial-phases',
      observe: (phase, step, operation) => { seen.push({ phase, step }); return operation() }
    })
    expect(seen).toEqual(WORKLOAD_STEPS.flatMap((step) => ['writer', 'reader', 'serialize', 'merge', 'oracle'].map((phase) => ({ phase, step }))))
  })

  it('applies the fixed corrupt-body control inside an oracle window and keeps the oracle error', () => {
    const observed: Array<{ phase: MainTrialPhase, step: string }> = []
    const facts = runMainTrialSample({
      k: 1000,
      runId: 'run-trial-control',
      observe: (phase, step, operation) => { observed.push({ phase, step }); return operation() },
      negativeControl: 'corrupt-body'
    })
    // Seed items carry a 1024-byte tool result, so the first oracle window is where the control can act.
    expect(facts.control).toMatchObject({ kind: 'corrupt-body', step: 'seed', rejected: true })
    expect(facts.control?.oracleError.startsWith(ORACLE_MISMATCH_PREFIX)).toBe(true)
    expect(observed.some((entry) => entry.phase === 'oracle' && entry.step === 'seed')).toBe(true)
    // The corruption is local to the control's clone, so the delivered sample stays healthy.
    expect(facts.steps.map((step) => step.itemCount)).toEqual(stageItemCounts(1000))
  })

  it('rejects a same-byte body corruption', () => {
    const raw = createWorkloadRun({ runId: 'nc-body', k: 1000 })
    for (const step of WORKLOAD_STEPS) applyWorkloadStep(raw, step, 1000)
    const delivered = oracleRun(raw) as ActiveRun
    expect(() => assertMatchesOracle(delivered, raw, 'clean')).not.toThrow()
    const corrupted = structuredClone(delivered)
    const target = corrupted.items.find((item) => typeof (item as { output?: unknown }).output === 'string' && ((item as { output: string }).output.length > 8)) as { output: string } | undefined
    if (!target) throw new Error('the workload must contain a tool body to corrupt')
    const original = target.output
    target.output = `${original.slice(0, 2)}${original[2] === 'x' ? 'y' : 'x'}${original.slice(3)}`
    expect(Buffer.byteLength(target.output, 'utf8')).toBe(Buffer.byteLength(original, 'utf8'))
    expect(() => assertMatchesOracle(corrupted, raw, 'corrupted')).toThrow(new RegExp(ORACLE_MISMATCH_PREFIX))
  })

  it('rejects a delta that omits the patch for a replaced item', () => {
    const raw = createWorkloadRun({ runId: 'nc-patch', k: 1000 })
    for (const step of WORKLOAD_STEPS.slice(0, WORKLOAD_STEPS.indexOf('backfill'))) applyWorkloadStep(raw, step, 1000)
    const runtime = createBoundedRuntime({ nextEventId: (prefix, runId) => `${prefix}:${runId}:1` })
    const revisions = createTraceRevisions()
    const first = runtime.boundedLiveRun(raw)
    const snapshot = revisions.observe(raw.runId, first.items, undefined)
    if (!snapshot.reset) throw new Error('the first read must be a snapshot')
    const applied = mergeRemoteTrace(null, transmit({ kind: 'snapshot', run: first, cursor: { revision: snapshot.revision, count: first.items.length } }))
    if (applied.kind !== 'applied' || !applied.view) throw new Error('the snapshot must apply')
    const baseView = applied.view
    const base = baseView.cursor
    if (!base) throw new Error('the snapshot must carry a cursor')
    applyWorkloadStep(raw, 'backfill', 1000)
    const bounded = runtime.boundedLiveRun(raw)
    const answer = revisions.observe(raw.runId, bounded.items, base)
    if (answer.reset) throw new Error('the backfill step must be delivered as a delta')
    const changeIndices = answer.changes
    if (changeIndices.length === 0) throw new Error('the backfill step must deliver at least one patch')
    const { items, ...meta } = bounded
    const real = transmit({
      kind: 'delta', run: meta, base: base.revision,
      cursor: { revision: answer.revision, count: answer.count },
      changes: changeIndices.map((index) => ({ index, item: items[index] }))
    })
    const mergedReal = mergeRemoteTrace(baseView, real)
    if (mergedReal.kind !== 'applied' || !mergedReal.view) throw new Error('the real delta must apply')
    const mergedRealView = mergedReal.view
    expect(() => assertMatchesOracle(mergedRealView.run, raw, 'real delta')).not.toThrow()
    const stale = mergeRemoteTrace(baseView, transmit({
      kind: 'delta', run: meta, base: base.revision, cursor: { revision: answer.revision, count: answer.count }, changes: []
    }))
    if (stale.kind !== 'applied' || !stale.view) throw new Error('the patchless delta must reach the oracle, not be refused by the merge')
    const staleView = stale.view
    expect(() => assertMatchesOracle(staleView.run, raw, 'missing patch')).toThrow(new RegExp(ORACLE_MISMATCH_PREFIX))
  })
})
