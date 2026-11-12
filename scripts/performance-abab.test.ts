import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TraceOutputBridge } from '../src/main/trace-output'
import { comparePerformance } from './performance-compare.mjs'
import { deliverTrace, events } from './performance-baseline-fixture'
import {
  ABAB_BATCHES,
  batchPlan,
  boundedStages,
  parseAbabArgs,
  parseProtocolLine,
  sideBatchId,
  stageKind,
  validateBatchSamples
} from './performance-abab-protocol.mjs'

const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }

describe('Node performance ABAB orchestration', () => {
  it('plans twenty paired batches in serial A/B order for every scenario', () => {
    const plan = batchPlan(['history.page', 'source-control.diff'])
    expect(plan).toHaveLength(ABAB_BATCHES * 2)
    expect(plan.slice(0, 2).flatMap(item => item.requests.map(request => request.batchId))).toEqual(['A1', 'B1', 'A2', 'B2'])
    expect(plan.at(-1)?.requests.map(request => request.batchId)).toEqual(['A20', 'B20'])
    expect(sideBatchId('baseline', 20)).toBe('A20')
    expect(sideBatchId('candidate', 20)).toBe('B20')
  })

  it('requires complete finite samples and preserves bounded stage diagnostics', () => {
    expect(() => validateBatchSamples({ sample: { outcome: 'completed', durationMs: [1] } }, ['sample'])).toThrow('not 20')
    expect(() => validateBatchSamples({ sample: { outcome: 'completed', durationMs: Array(20).fill(Number.NaN) } }, ['sample'])).toThrow('invalid')
    expect(boundedStages(Array.from({ length: 300 }, (_, index) => index))).toHaveLength(256)
    expect(stageKind('fs/promises', 'file')).toBe('file-operation')
    expect(stageKind('git', 'git')).toBe('git-command')
    expect(stageKind('other', 'work')).toBe('benchmark-operation')
  })

  it('supports an explicit same-source control without weakening the batch contract', () => {
    expect(parseAbabArgs(['--candidate', '/candidate', '--output', '/results', '--same-source'])).toMatchObject({
      baseline: '/candidate', candidate: '/candidate', sameSource: true, rounds: 3, batches: 20
    })
    expect(() => parseAbabArgs(['--candidate', '/candidate', '--output', '/results'])).toThrow('--baseline')
    expect(parseProtocolLine('{"id":1,"ok":true}')).toEqual({ id: 1, ok: true })
  })

  it('defines one manual read-only job with three rounds and failure-preserving artifacts', () => {
    const workflow = load(readFileSync(join(import.meta.dirname, '..', '.github/workflows/performance.yml'), 'utf8')) as {
      on: { workflow_dispatch: { inputs: { baseline: { required: boolean } } } }
      permissions: { contents: string }
      jobs: Record<string, { steps: Array<{ name?: string; if?: string; run?: string }> }>
    }
    expect(workflow.on.workflow_dispatch.inputs.baseline.required).toBe(true)
    expect(workflow.permissions.contents).toBe('read')
    expect(Object.keys(workflow.jobs)).toEqual(['abab'])
    expect(workflow).toHaveProperty('name', 'Performance ABAB branch experiment')
    const run = workflow.jobs.abab.steps.find(step => step.name === 'Run three serial ABAB rounds on one runner')?.run ?? ''
    expect(run).toContain('--rounds 3')
    expect(run).toContain('--batches 20')
    expect(workflow.jobs.abab.steps.find(step => step.name === 'Summarize complete rounds with the unchanged comparator')?.if).toBe('always()')
    expect(workflow.jobs.abab.steps.find(step => step.name === 'Preserve all original ABAB results and logs')?.if).toBe('always()')
  })

  it('uses all twenty samples for P95 and still rejects a real work increase', () => {
    const policy = JSON.parse(readFileSync(join(import.meta.dirname, 'performance-budgets.json'), 'utf8'))
    const samplingPolicy = structuredClone(policy)
    const results = Object.fromEntries(Object.keys(policy.scenarios).map(name => {
      samplingPolicy.scenarios[name].samples = 20
      return [name, { ...policy.scenarios[name], samples: 20, durationMs: Array(20).fill(0), outcome: 'completed' }]
    }))
    const baseline = { schema: 1, revision: 'a'.repeat(40), harness: 'test-harness', environment: {},
      measurement: { kind: 'batch-mean-ms', warmups: 3, samples: 20, iterationsPerSample: 20, perScenario: true, interleaved: true }, results }
    const candidate = structuredClone(baseline)
    baseline.results['source-control.diff'].durationMs = [...Array(18).fill(10), 20, 1000]
    candidate.results['source-control.diff'].durationMs = [...Array(18).fill(10), 25, 2000]
    const report = comparePerformance(baseline, candidate, samplingPolicy, 20)
    expect(report.rows.find(row => row.scenario === 'source-control.diff' && row.metric === 'batchMeanP95Ms'))
      .toMatchObject({ baseline: 20, candidate: 25, ceiling: 30, status: 'pass' })
    expect(() => comparePerformance(baseline, candidate, policy)).toThrow('methodology')
    baseline.results['trace.delivery'].counters = deliverTrace(events)
    candidate.results['trace.delivery'].counters = deliverTrace([...events, ...events])
    const control = comparePerformance(baseline, candidate, samplingPolicy, 20)
    expect(control.rows.find(row => row.scenario === 'trace.delivery' && row.metric === 'events')?.status).toBe('regressed')
  })

  it('keeps the genuine duplicate-publication work-increase negative control', () => {
    const events = Array.from({ length: 8 }, (_, index) => ({ id: `event-${index}`, runId: 'run', ts: '2026-01-01T00:00:00.000Z', kind: 'model' as const, stage: 'text_delta' as const, messageId: 'message', text: 'fixed' }))
    const deliver = (input: typeof events) => {
      let bytes = 0
      let delivered = 0
      const bridge = new TraceOutputBridge({ canSend: () => true, schedule: () => () => {}, send: batch => { bytes += Buffer.byteLength(JSON.stringify(batch)); delivered += batch.events.length } })
      for (const event of input) bridge.push(event)
      bridge.flushAll()
      bridge.close()
      return { bytes, delivered }
    }
    const normal = deliver(events)
    const duplicated = deliver([...events, ...events])
    expect(duplicated.delivered).toBe(normal.delivered * 2)
    expect(duplicated.bytes).toBeGreaterThan(normal.bytes)
  })
})
