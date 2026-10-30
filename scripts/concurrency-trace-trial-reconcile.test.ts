import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '../src/shared/trace'
import { applyWorkloadStep, createWorkloadRun, WORKLOAD_STEPS } from './fixtures/concurrency-trace-workload'
import { reconcileRun } from './fixtures/concurrency-trace-trial-report'

// Small k: the reconciliation contract is about identities and byte budgets, not about scale, so
// this stays a small test instead of replaying the trial's cells.
const K = 64
const RUN_ID = 'run-reconcile-1'

// One real completed run, produced by the writer the trial uses. Every case below corrupts exactly
// one field of a copy, so no second expected workload is generated and the expectation cannot be
// rebuilt from the value under verification.
const completed = (): ActiveRun => {
  const run = createWorkloadRun({ runId: RUN_ID, k: K })
  for (const step of WORKLOAD_STEPS) applyWorkloadStep(run, step, K)
  return run
}

const corruptProblems = (mutate: (run: ActiveRun) => void): string[] => {
  const run = structuredClone(completed())
  mutate(run)
  return reconcileRun(run, K).problems
}

const replacementOf = (items: TraceEvent[]): TraceEvent => {
  const item = items.find((candidate) => candidate.runtimeMetadata?.replacesStreamedText === true)
  if (!item) throw new Error('the completed run has no stream replacement')
  return item
}

const tailOf = (items: TraceEvent[]): TraceEvent => {
  const item = items.at(-1)
  if (!item) throw new Error('the completed run has no tail item')
  return item
}

describe('trial reconciliation contract', () => {
  it('accepts the completed run', () => {
    expect(reconcileRun(completed(), K)).toMatchObject({
      items: K, done: true, earlyToolResultBytes: 8192,
      streamReplacements: 1, leftoverStreamDeltas: 0, tailCoalesced: true, problems: []
    })
  })

  it('rejects a stream replacement whose contract metadata was altered', () => {
    expect(corruptProblems((run) => { replacementOf(run.items).kind = 'harness' }))
      .toContain('the stream replacement is not a model item')
    expect(corruptProblems((run) => { replacementOf(run.items).stage = 'text_delta' }))
      .toContain('the stream replacement is not a completed text item')
    expect(corruptProblems((run) => { replacementOf(run.items).messageId = 'msg:other:stream' }))
      .toContain('the stream replacement is not on the stream message')
    expect(corruptProblems((run) => { delete replacementOf(run.items).messageId }))
      .toContain('the stream replacement is not on the stream message')
    expect(corruptProblems((run) => { replacementOf(run.items).id = `wt:${RUN_ID}:stream-part` }))
      .toContain('the stream replacement is not the final stream item')
    expect(corruptProblems((run) => { replacementOf(run.items).text = 'merged by hand' }))
      .toContain('the stream replacement body is not the authoritative text')
  })

  it('rejects a tail item that is not the coalesced tail delta', () => {
    expect(corruptProblems((run) => { tailOf(run.items).text = 'partial tail' }))
      .toContain('the tail body is not the coalesced tail text')
    expect(corruptProblems((run) => { tailOf(run.items).id = `wt:${RUN_ID}:append-0` }))
      .toContain('the tail item is not the coalesced tail delta')
    expect(corruptProblems((run) => { tailOf(run.items).kind = 'harness' }))
      .toContain('the tail item is not a model text delta')
    expect(corruptProblems((run) => { tailOf(run.items).stage = 'text' }))
      .toContain('the tail item is not a model text delta')
    expect(corruptProblems((run) => { tailOf(run.items).messageId = 'msg:other:tail' }))
      .toContain('the tail item is not on the tail message')
  })

  it('keeps the fixed item, done and byte-budget contract', () => {
    expect(corruptProblems((run) => { run.items.pop() })).toContain(`item count is ${K - 1}, contract is ${K}`)
    expect(corruptProblems((run) => { run.done = false })).toContain('run is not done after the done step')
    expect(corruptProblems((run) => { run.items[2].output = 'too short' }))
      .toContain('early tool result is 9 bytes, contract is 8192')
  })
})
