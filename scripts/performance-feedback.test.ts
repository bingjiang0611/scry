import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comparePerformance, formatComparison } from './performance-compare.mjs'
import { checkCatalogue, summarize as summarizeRecords, observations, readRecords } from './performance-report.mjs'
import { duplicateTraceControl } from './performance-baseline.test'

const summarize = (records, baseline, candidate) => summarizeRecords([
  ...records,
  ...[...new Map(records.map(record => [`${record.build}:${record.session}`, record])).values()].map(record => ({
    ...record, observation: { kind: 'health', sample: { droppedRecords: 0, closed: true } }
  }))
], baseline, candidate)

const policy = JSON.parse(readFileSync(new URL('./performance-budgets.json', import.meta.url), 'utf8'))
const benchmark = () => ({
  schema: 1, measurement: { kind: 'batch-mean-ms', iterationsPerSample: 20 }, harness: 'same-fixture', revision: 'base', environment: { node: '22', platform: 'test' },
  results: Object.fromEntries(Object.entries(policy.scenarios).map(([name, budget]) => [name, {
    counters: { ...(budget as { counters: Record<string, number> }).counters }, durationMs: Array(15).fill(1)
  }]))
})
const record = (build: string, durationMs: number, index: number) => ({
  schema: 1, build, version: '1', mode: 'packaged', platform: 'test', arch: 'test', cpu: 'test', runtime: 'test',
  session: `session-${index % 2}`,
  observation: { kind: 'trace', sample: { name: 'session_history.load', dimensions: { provider: 'claude' }, outcome: 'completed', durationMs, checkpoints: [], counters: { returnedTurns: 40 } } }
})

describe('performance feedback contract', () => {
  it('maps existing source entrypoints and resolves every source reference', () => {
    expect(checkCatalogue().paths).toHaveLength(16)
  })

  it('fails on regression, missing metrics, insufficient samples and incompatible fixtures/environments', () => {
    const base = benchmark()
    const head = structuredClone(base)
    expect(comparePerformance(base, head, policy).passed).toBe(true)
    head.results['trace.delivery'].counters = duplicateTraceControl()
    const report = comparePerformance(base, head, policy)
    expect(report.passed).toBe(false)
    expect(formatComparison(report)).toContain('regressed')
    expect(formatComparison(report)).toContain('Baseline')
    head.results['trace.delivery'].durationMs = Array(15).fill(100)
    expect(comparePerformance(base, head, policy).rows.some(row => row.metric === 'batchMeanP95Ms' && row.status === 'regressed')).toBe(true)
    delete head.results['history.page']
    expect(() => comparePerformance(base, head, policy)).toThrow('scenarios')
    expect(() => comparePerformance(base, { ...base, harness: 'shrunk-fixture' }, policy)).toThrow('Harness differs')
    expect(() => comparePerformance(base, { ...base, environment: { node: '24' } }, policy)).toThrow('Environment differs')
    const short = benchmark()
    short.results['trace.delivery'].durationMs = []
    expect(() => comparePerformance(base, short, policy)).toThrow('timing samples')
  })

  it('the CLI exits nonzero for real duplicate publication and keeps the report', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scry-performance-gate-'))
    try {
      const base = benchmark()
      const head = structuredClone(base)
      head.results['trace.delivery'].counters = duplicateTraceControl()
      writeFileSync(join(directory, 'base.json'), JSON.stringify(base))
      writeFileSync(join(directory, 'head.json'), JSON.stringify(head))
      const result = spawnSync(process.execPath, ['scripts/performance-compare.mjs', join(directory, 'base.json'), join(directory, 'head.json'), 'scripts/performance-budgets.json', join(directory, 'report.md')], {
        encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' }
      })
      expect(result.status).toBe(1)
      expect(readFileSync(join(directory, 'report.md'), 'utf8')).toContain('regressed')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('retains valid records but flags an invalid final record as incomplete', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'scry-performance-tail-'))
    try {
      writeFileSync(join(directory, 'performance-0.jsonl'), `${JSON.stringify(record('before', 20, 0))}\n{"schema":`)
      const { records, issues } = await readRecords(directory)
      expect(records).toHaveLength(1)
      expect(issues).toHaveLength(1)
      expect(summarizeRecords(records, 'before', 'after', issues).rows[0].status).toBe('incomplete-recording')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('detects cumulative drift even when the latest change is small', () => {
    const base = benchmark()
    base.results['trace.delivery'].counters.bytes = policy.scenarios['trace.delivery'].counters.bytes - 1
    const head = structuredClone(base)
    head.results['trace.delivery'].counters.bytes += 2
    expect(comparePerformance(base, head, policy).passed).toBe(false)
  })

  it('keeps real-use cohorts separate and requires samples from multiple app sessions', () => {
    const records = [
      ...Array.from({ length: 30 }, (_, i) => record('before', 100, i)),
      ...Array.from({ length: 30 }, (_, i) => record('after', 50, i))
    ]
    expect(summarize(records, 'before', 'after').rows[0].status).toBe('improved')
    expect(summarize([record('before', 100, 0), record('after', 50, 0)], 'before', 'after').rows[0].status).toBe('insufficient-data')
    const changedWorkload = structuredClone(records)
    changedWorkload[30].observation.sample.counters.returnedTurns = 4000
    expect(summarize(changedWorkload, 'before', 'after').rows.some(row => row.status === 'unmatched-workload-or-environment')).toBe(true)
    const changedEnvironment = records.map(entry => entry.build === 'after' ? { ...entry, cpu: 'different' } : entry)
    expect(summarize(changedEnvironment, 'before', 'after').rows.every(row => row.status === 'unmatched-workload-or-environment')).toBe(true)
  })

  it('does not count failed or unavailable milestones as fast successful operations', () => {
    const records = [
      ...Array.from({ length: 35 }, (_, i) => record('before', 100, i)),
      ...Array.from({ length: 35 }, (_, i) => record('after', 50, i))
    ]
    for (const item of records.slice(-5)) item.observation.sample.outcome = 'unavailable'
    const row = summarize(records, 'before', 'after').rows[0]
    expect(row.status).toBe('completion-rate-regressed')
    expect(row.candidate.count).toBe(30)
    expect(row.candidate.outcomes.unavailable).toBe(5)
    for (const item of records.slice(-5)) delete item.observation.sample.counters
    expect(summarize(records, 'before', 'after').rows.every(row => row.status === 'completion-rate-regressed')).toBe(true)
    expect(summarizeRecords(records, 'before', 'after').rows.every(row => row.status === 'incomplete-recording')).toBe(true)
    expect(observations({ observation: { kind: 'renderer', sample: { windowMs: 5000, longTaskSupported: false, longTaskCount: 0 } } }).some(item => item.metric === 'longTaskCount')).toBe(false)
  })
})
