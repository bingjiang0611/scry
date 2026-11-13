import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FORMAL_SAMPLE_COUNT, comparePerformance, timingCeiling } from './performance-compare.mjs'
import { batchPlan, parseAbabArgs, parseProtocolLine, recordDiagnosticStage, sideBatchId, stageKind, validateBatchSamples, validateStageTotals } from './performance-abab-protocol.mjs'
import { runBatchPlan } from './performance-abab.mjs'
import { summarizeAbab } from './performance-abab-report.mjs'

const policy = JSON.parse(readFileSync(join(import.meta.dirname, 'performance-budgets.json'), 'utf8'))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function artifact(side: 'baseline' | 'candidate') {
  const results = Object.fromEntries(Object.entries(policy.scenarios).map(([name, budget]) => [name, {
    ...(budget as object), samples: 20, outcome: 'completed', counters: { ...(budget as { counters: object }).counters }, durationMs: Array(20).fill(10)
  }]))
  const batches = Object.entries(policy.scenarios).flatMap(([scenario, budget]) => Array.from({ length: 20 }, (_, index) => {
    const batch = { side, scenario, batchId: sideBatchId(side, index + 1), stages: [], stageTotals: {}, droppedStageCount: 0 }
    if ((budget as { lane: string }).lane === 'disk' || scenario === 'source-control.diff') recordDiagnosticStage(batch, 'file-operation', 'readFile', 0, 1)
    if (scenario === 'source-control.diff') recordDiagnosticStage(batch, 'git-command', 'git diff', 0, 1)
    return batch
  }))
  return { schema: 1, revision: 'a'.repeat(40), harness: 'harness', environment: {}, measurement: {
    kind: 'batch-mean-ms', warmups: 3, samples: 20, iterationsPerSample: 20, perScenario: true, interleaved: true
  }, results, diagnostics: { batches } }
}

describe('formal Node performance ABAB contract', () => {
  it('plans exactly twenty paired batches for every scenario', () => {
    const plan = batchPlan(['history.page', 'source-control.diff'])
    expect(plan).toHaveLength(FORMAL_SAMPLE_COUNT * 2)
    expect(plan.slice(0, 2).flatMap(item => item.requests.map(request => request.batchId))).toEqual(['A1', 'B1', 'A2', 'B2'])
    expect(plan.at(-1)?.requests.map(request => request.batchId)).toEqual(['A20', 'B20'])
    expect(() => batchPlan(['history.page'], 21)).toThrow('must be 20')
  })

  it('actually awaits each response before dispatching the other side', async () => {
    const plan = batchPlan(['history.page'])
    const observed: string[] = []
    let active = 0
    const client = (side: 'baseline' | 'candidate') => ({
      request: async (request: { scenario: string; batchId: string }) => {
        active++
        expect(active).toBe(1)
        observed.push(`start ${request.batchId}`)
        await Promise.resolve()
        observed.push(`end ${request.batchId}`)
        active--
        return { ...request, side }
      }
    })
    await runBatchPlan(plan, { baseline: client('baseline'), candidate: client('candidate') })
    expect(observed).toEqual(plan.flatMap(item => item.requests.flatMap(request => [`start ${request.batchId}`, `end ${request.batchId}`])))
  })

  it('rejects an RPC response for a different side or batch', async () => {
    const client = { request: async () => ({ side: 'candidate', scenario: 'history.page', batchId: 'B1' }) }
    await expect(runBatchPlan(batchPlan(['history.page']), { baseline: client, candidate: client })).rejects.toThrow('identity mismatch')
  })

  it('uses the real recording helper to retain all totals after the detail cap', () => {
    const batch = { side: 'baseline', scenario: 'workspace.files', batchId: 'A1', stages: [], stageTotals: {}, droppedStageCount: 0 }
    for (let index = 1; index <= 300; index++) recordDiagnosticStage(batch, 'file-operation', 'readFile', 0, index)
    expect(batch.stages).toHaveLength(256)
    expect(batch.droppedStageCount).toBe(44)
    expect(batch.stageTotals).toEqual({ 'file-operation': { count: 300, totalMs: 45150, maxMs: 300 } })
    expect(() => validateStageTotals(batch)).not.toThrow()
    expect(() => validateStageTotals({ ...batch, droppedStageCount: 43 })).toThrow('accounting')
    expect(stageKind('fs/promises', 'file')).toBe('file-operation')
    expect(stageKind('git', 'git')).toBe('git-command')
  })

  it('requires complete finite samples and the unchanged absolute/base-relative formula', () => {
    expect(() => validateBatchSamples({ sample: { outcome: 'completed', durationMs: [1] } }, ['sample'])).toThrow('not 20')
    expect(() => validateBatchSamples({ sample: { outcome: 'completed', durationMs: Array(20).fill(Number.NaN) } }, ['sample'])).toThrow('invalid')
    const base = artifact('baseline')
    const head = artifact('candidate')
    expect(comparePerformance(base, head, policy).passed).toBe(true)
    expect(timingCeiling(20, 1000)).toBe(30)
    expect(timingCeiling(20, 25)).toBe(25)
    expect(timingCeiling(3000, 1000)).toBe(1000)
    expect(() => comparePerformance({ ...base, measurement: { ...base.measurement, samples: 15 } }, head, policy)).toThrow('methodology')
    head.results['source-control.diff'].durationMs[19] = 1000
    expect(comparePerformance(base, head, policy).passed).toBe(true)
    head.results['source-control.diff'].durationMs[18] = 1000
    expect(comparePerformance(base, head, policy).passed).toBe(false)
  })

  it('fails closed for missing stage evidence or failed worker cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-abab-report-'))
    roots.push(root)
    writeFileSync(join(root, 'summary.json'), JSON.stringify({ status: 'completed', errors: [] }))
    writeFileSync(join(root, 'baseline.json'), JSON.stringify(artifact('baseline')))
    const candidate = artifact('candidate')
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(candidate))
    expect(summarizeAbab(root)).toBe(true)
    candidate.diagnostics.batches[0].stageTotals = {}
    candidate.diagnostics.batches[0].stages = []
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(candidate))
    expect(summarizeAbab(root)).toBe(false)
    expect(readFileSync(join(root, 'report.md'), 'utf8')).toContain('Missing file stage evidence')
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(artifact('candidate')))
    writeFileSync(join(root, 'summary.json'), JSON.stringify({ status: 'failed', errors: ['fixture cleanup failed'] }))
    expect(summarizeAbab(root)).toBe(false)
    expect(readFileSync(join(root, 'report.md'), 'utf8')).toContain('fixture cleanup failed')
  })

  it('rejects missing baseline and preserves same-source diagnostic parsing', () => {
    expect(parseAbabArgs(['--candidate', '/candidate', '--output', '/results', '--same-source'])).toMatchObject({ baseline: '/candidate', candidate: '/candidate', sameSource: true, batches: 20 })
    expect(() => parseAbabArgs(['--candidate', '/candidate', '--output', '/results'])).toThrow('--baseline')
    expect(parseProtocolLine('{"id":1,"ok":true}')).toEqual({ id: 1, ok: true })
  })
})
