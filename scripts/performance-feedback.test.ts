import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comparePerformance, formatComparison } from './performance-compare.mjs'
import { checkCatalogue, pathForOperation, snapshotPerformanceDirectory, summarize as summarizeRecords, summarizeBaseline, observations, readRecords } from './performance-report.mjs'
import { PerformanceJournal } from '../src/main/performance-journal'

const summarize = (records, baseline, candidate) => summarizeRecords([
  ...records,
  ...[...new Map(records.map(record => [`${record.build}:${record.session}`, record])).values()].map(record => ({
    ...record, observation: { kind: 'health', sample: { droppedRecords: 0, closed: true } }
  }))
], baseline, candidate)

const policy = JSON.parse(readFileSync(new URL('./performance-budgets.json', import.meta.url), 'utf8'))
const benchmark = () => ({
  schema: 1, measurement: { kind: 'batch-mean-ms', warmups: 3, samples: 15, iterationsPerSample: 20, perScenario: true }, harness: 'same-fixture', revision: 'base', environment: { node: '22', platform: 'test' },
  results: Object.fromEntries(Object.entries(policy.scenarios).map(([name, budget]) => [name, {
    lane: (budget as { lane: string }).lane, workload: (budget as { workload: string }).workload,
    iterations: (budget as { iterations: number }).iterations, warmups: (budget as { warmups: number }).warmups, samples: (budget as { samples: number }).samples, outcome: 'completed',
    counters: { ...(budget as { counters: Record<string, number> }).counters }, durationMs: Array((budget as { samples: number }).samples).fill(1)
  }]))
})
const record = (build: string, durationMs: number, index: number) => ({
  schema: 1, build, version: '1', mode: 'packaged', platform: 'test', arch: 'test', cpu: 'test', runtime: 'test',
  session: `session-${index % 2}`,
  observation: { kind: 'trace', sample: { name: 'session_history.load', dimensions: { provider: 'claude' }, outcome: 'completed', durationMs, checkpoints: [], counters: { returnedTurns: 40 } } }
})

describe('performance feedback contract', () => {
  it('maps existing source entrypoints and resolves every source reference', () => {
    const catalogue = checkCatalogue()
    expect(catalogue.paths).toHaveLength(16)
    expect(catalogue.paths.every(path => path.benchmarks.length > 0)).toBe(true)
    expect(new Set(catalogue.paths.flatMap(path => path.benchmarks))).toEqual(new Set(Object.keys(policy.scenarios)))
  })

  it('fails on regression, missing metrics, insufficient samples and incompatible fixtures/environments', () => {
    const base = benchmark()
    const head = structuredClone(base)
    expect(comparePerformance(base, head, policy).passed).toBe(true)
    head.results['trace.delivery'].counters.events *= 2
    head.results['trace.delivery'].counters.bytes *= 2
    const report = comparePerformance(base, head, policy)
    expect(report.passed).toBe(false)
    expect(formatComparison(report)).toContain('regressed')
    expect(formatComparison(report)).toContain('Baseline')
    head.results['trace.delivery'].durationMs = Array(15).fill(100)
    expect(comparePerformance(base, head, policy).rows.some(row => row.metric === 'batchMeanP95Ms' && row.status === 'regressed')).toBe(true)
    delete head.results['history.page']
    expect(() => comparePerformance(base, head, policy)).toThrow('scenarios')
    expect(() => comparePerformance(base, { ...base, harness: 'shrunk-fixture' }, policy)).toThrow('Harness differs')
    const missingOutcome = structuredClone(base)
    delete missingOutcome.results['trace.delivery'].outcome
    expect(() => comparePerformance(base, missingOutcome, policy)).toThrow('Missing successful outcome')
    const changedWorkload = structuredClone(base)
    changedWorkload.results['trace.delivery'].workload = 'shrunk-fixture'
    expect(() => comparePerformance(base, changedWorkload, policy)).toThrow('Scenario methodology differs')
    const changedLane = structuredClone(base)
    changedLane.results['trace.delivery'].lane = 'process'
    expect(() => comparePerformance(base, changedLane, policy)).toThrow('Scenario methodology differs')
    const lostOutput = structuredClone(base)
    delete lostOutput.results['trace.delivery'].counters.bytes
    expect(() => comparePerformance(base, lostOutput, policy)).toThrow('Counter coverage differs')
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
      head.results['trace.delivery'].counters.events *= 2
      head.results['trace.delivery'].counters.bytes *= 2
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

  it('reports a provisional single-build baseline for all paths without inventing missing data', () => {
    const records = [record('hash', 10, 0), record('hash', 20, 1),
      { ...record('hash', 0, 0), observation: { kind: 'health', sample: { droppedRecords: 0, closed: true } } },
      { ...record('hash', 0, 1), observation: { kind: 'health', sample: { droppedRecords: 0, closed: true } } }]
    // A version label may identify several builds; only an exact build identity is accepted.
    expect(() => summarizeBaseline(records, '0.2.190')).toThrow('Requested build is absent')
    const report = summarizeBaseline(records, 'hash')
    expect(report.paths).toHaveLength(16)
    expect(report.maturity).toMatchObject({ status: 'provisional' })
    expect(report.maturity.reasons).toContain('short-recording')
    expect(summarizeBaseline([record('hash', 10, 0)], 'hash').maturity.reasons).toContain('live-session-not-closed')
    expect(report.source.immutable).toBe(false)
    expect(report.coverage.unavailablePaths).toContain('startup')
    const historyPath = report.paths.find(path => path.id === 'history')
    expect(historyPath.status).toBe('observed-provisional')
    expect(historyPath.workloads[0]).toMatchObject({ samples: 2, completed: 2, p50: 10, p75: 20, p95: 20, outcomes: { completed: 2 } })
    const directory = mkdtempSync(join(tmpdir(), 'scry-performance-baseline-cli-'))
    try {
      writeFileSync(join(directory, 'performance-0.jsonl'), `${JSON.stringify(record('hash', 10, 0))}\n`)
      const result = spawnSync(process.execPath, ['scripts/performance-report.mjs', 'report', 'baseline', directory, 'hash'], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'single-build-baseline', build: 'hash', maturity: { status: 'provisional' } })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('snapshots and reads a real rotated journal, including compressed archives, oldest first', async () => {
    const source = mkdtempSync(join(tmpdir(), 'scry-performance-archive-'))
    const target = join(source, 'snapshot')
    try {
      const environment = { version: 'test', build: 'archived', mode: 'development' as const, platform: 'test', osRelease: 'test', arch: 'test', cpu: 'test', runtime: 'test' }
      const journal = new PerformanceJournal({ directory: source, environment, maxFileBytes: 900, onError: () => { throw new Error('journal failed') } })
      await journal.open()
      for (let index = 0; index < 12; index++) journal.record({ kind: 'trace', sample: { name: 'ipc.agent:loadSession', durationMs: index, outcome: 'completed', startedAt: '2026-01-01T00:00:00.000Z', dimensions: {}, checkpoints: [] } })
      await journal.close()
      snapshotPerformanceDirectory(source, target)
      const { records, issues } = await readRecords(target)
      expect(issues).toEqual([])
      expect(JSON.parse(readFileSync(join(target, 'snapshot-manifest.json'), 'utf8')).files.some((file: { name: string }) => file.name.endsWith('.jsonl.gz'))).toBe(true)
      const durations = records.filter(item => item.observation.kind === 'trace').map(item => item.observation.sample.durationMs)
      expect(durations).toEqual(Array.from({ length: 12 }, (_, index) => index))
      expect(records.at(-1).observation.kind).toBe('health')
    } finally { rmSync(source, { recursive: true, force: true }) }
  })

  it('keeps same-millisecond rotations ordered across restart and clock rollback without changing record timestamps', async () => {
    const source = mkdtempSync(join(tmpdir(), 'scry-performance-same-clock-'))
    const target = join(source, 'snapshot')
    const onError = vi.fn()
    const environment = { version: 'test', build: 'same-clock', mode: 'development' as const, platform: 'test', osRelease: 'test', arch: 'test', cpu: 'test', runtime: 'test' }
    const journals: PerformanceJournal[] = []
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (let session = 0; session < 2; session++) {
        vi.setSystemTime(session === 0 ? '2026-10-16T00:00:00.000Z' : '2026-10-15T00:00:00.000Z')
        const journal = new PerformanceJournal({ directory: source, environment, maxFileBytes: 900, onError })
        journals.push(journal)
        await journal.open()
        for (let index = 0; index < 12; index++) journal.record({ kind: 'trace', sample: {
          name: 'ipc.agent:loadSession', durationMs: session * 12 + index, outcome: 'completed',
          startedAt: '2026-01-01T00:00:00.000Z', dimensions: {}, checkpoints: []
        } })
        await journal.close()
      }
      const stamps = readdirSync(source).flatMap(name => {
        const match = /^performance-(\d{8}T\d{9}Z)-[0-9a-f]{8}\.jsonl\.gz$/.exec(name)
        return match ? [match[1]] : []
      })
      expect(stamps.length).toBeGreaterThan(2)
      expect(new Set(stamps).size).toBe(stamps.length)
      snapshotPerformanceDirectory(source, target)
      const { records, issues } = await readRecords(target)
      expect(issues).toEqual([])
      expect(records.filter(item => item.observation.kind === 'trace').map(item => item.observation.sample.durationMs))
        .toEqual(Array.from({ length: 24 }, (_, index) => index))
      expect(new Set(records.map(item => item.recordedAt))).toEqual(new Set(['2026-10-16T00:00:00.000Z', '2026-10-15T00:00:00.000Z']))
      expect(records.at(-1).observation.kind).toBe('health')
      expect(new Set(records.map(item => item.session)).size).toBe(2)
      expect(onError).not.toHaveBeenCalled()
    } finally {
      for (const journal of journals) await journal.close()
      vi.useRealTimers()
      rmSync(source, { recursive: true, force: true })
    }
  })

  it('creates hashed bounded snapshots, detects modification and refuses overwrite', async () => {
    const source = mkdtempSync(join(tmpdir(), 'scry-performance-source-'))
    const target = join(source, 'snapshot')
    try {
      writeFileSync(join(source, 'performance-0.jsonl'), `${JSON.stringify(record('hash', 10, 0))}\n`)
      const snapshot = snapshotPerformanceDirectory(source, target)
      expect(snapshot.immutable).toBe(false)
      expect((await readRecords(target)).issues).toEqual([])
      writeFileSync(join(target, 'performance-0.jsonl'), `${JSON.stringify(record('hash', 999, 0))}\n`)
      expect((await readRecords(target)).issues).toContainEqual({ file: 'performance-0.jsonl', reason: 'snapshot-hash-mismatch-or-unverified' })
      expect(existsSync(join(target, 'performance-0.jsonl'))).toBe(true)
      expect(existsSync(join(target, 'snapshot-manifest.json'))).toBe(true)
      expect(() => snapshotPerformanceDirectory(source, target)).toThrow('overwrite')
    } finally { rmSync(source, { recursive: true, force: true }) }
  })

  it('includes resource and renderer windows once, with separate metric units', () => {
    const records = [
      { ...record('hash', 0, 0), observation: { kind: 'resource', sample: { windowMs: 5000, main: { rssBytes: 1024, eventLoopP95Ms: 10 }, processes: [{ type: 'Browser', cpuPercentOfOneCore: 12, workingSetBytes: 1024, peakWorkingSetBytes: 2048, privateBytes: 512 }], counters: {} } } },
      { ...record('hash', 0, 0), observation: { kind: 'renderer', sample: { windowMs: 5000, maxFrameGapMs: 30, frameCount: 100, slowFrameCount: 2, longTaskSupported: false } } }
    ]
    const report = summarizeBaseline(records, 'hash')
    expect(report.paths.reduce((sum, path) => sum + path.samples, 0)).toBe(2)
    const metrics = report.paths.flatMap(path => path.workloads)
    expect(metrics).toContainEqual(expect.objectContaining({ metric: 'rssBytes', unit: 'bytes', p50: 1024 }))
    expect(metrics).toContainEqual(expect.objectContaining({ metric: 'slowFrameRatio', unit: 'ratio', p50: 0.02 }))
    expect(metrics).toContainEqual(expect.objectContaining({ metric: 'process.Browser.cpuPercentOfOneCore', unit: 'percent-of-one-core', p50: 12 }))
    expect(metrics.some(metric => metric.metric === 'longestLongTaskMs')).toBe(false)
    expect(report.unavailableMetrics.rendererLongTasks).toBe(1)
  })

  it('rejects padding scenario counts instead of covering the required path', () => {
    const padded = structuredClone(policy)
    padded.scenarios.padding = padded.scenarios['providers.catalog']
    delete padded.scenarios['providers.catalog']
    expect(() => comparePerformance(benchmark(), benchmark(), padded)).toThrow('Missing executable benchmark coverage: providers')
  })

  it('rejects lost output, not just output growth', () => {
    const base = benchmark()
    const head = structuredClone(base)
    head.results['terminal.delivery'].counters.outputBytes--
    expect(comparePerformance(base, head, policy).passed).toBe(false)
  })

  it('detects cumulative drift even when the latest change is small', () => {
    const base = benchmark()
    base.results['terminal.delivery'].counters.bytes = policy.scenarios['terminal.delivery'].counters.bytes - 1
    const head = structuredClone(base)
    head.results['terminal.delivery'].counters.bytes += 2
    expect(comparePerformance(base, head, policy).passed).toBe(false)
  })

  it('keeps real-use cohorts separate and requires samples from multiple app sessions', () => {
    const records = [
      ...Array.from({ length: 30 }, (_, i) => record('before', 100, i)),
      ...Array.from({ length: 30 }, (_, i) => record('after', 50, i))
    ]
    expect(summarize(records, 'before', 'after').rows[0].status).toBe('improved')
    const heartbeats = records.map(item => ({ ...item, observation: { kind: 'health', sample: { droppedRecords: 0, closed: false } } }))
    expect(summarizeRecords([...records, ...heartbeats], 'before', 'after').rows[0].status).toBe('incomplete-recording')
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
    const benchmarkObservations = observations({ observation: { kind: 'benchmark', sample: {
      results: { 'history.page': { lane: 'domain', workload: 'turns=4000', outcome: 'completed', counters: { turns: 40 }, durationMs: [1, 2, 3] } }
    } } })
    expect(pathForOperation(benchmarkObservations.find(item => item.metric === 'counter.turns').operation)).toBe('history')
    expect(benchmarkObservations.find(item => item.metric === 'counter.turns')).toMatchObject({ workload: 'domain;turns=4000' })
  })
})
