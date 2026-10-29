import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WORKLOAD_STEPS } from './fixtures/concurrency-trace-workload'
import { MAIN_50K_FIXED_ITEMS, MAIN_50K_STAGE_COUNTS, assembleReport, runTimedSample, type Measurement } from './fixtures/concurrency-trace-main-50k-sample'
import type { MainTrialControlFacts, MainTrialFacts } from './fixtures/concurrency-trace-main-trial'

interface CellReportModule { readReport(path: string): Record<string, unknown> }
interface OwnedRecord { phase: string; owned: { status: string; error?: string } | null }
interface LifecycleModule {
  ownedChild(input: Record<string, unknown>): { ready(run: () => Promise<unknown>): Promise<unknown>, shutdown(reason?: string): Promise<OwnedRecord> }
  lifecycleVerdict(records: OwnedRecord[]): { ok: boolean, issues: string[] }
}

// Hoisted so the mock factory below can read it: the factory runs while the module graph loads.
const trialFailure = vi.hoisted(() => ({ enabled: false }))

// The only untested path in this lane is the timed sample's own exception handling, so one test swaps the shared
// sample for a stub that calls the real observer twice and then throws. No production hook, config or clock
// framework is added: with the switch off this is the real runMainTrialSample.
vi.mock('./fixtures/concurrency-trace-main-trial', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fixtures/concurrency-trace-main-trial')>()
  return {
    ...actual,
    runMainTrialSample: (input: Parameters<typeof actual.runMainTrialSample>[0]) => {
      if (!trialFailure.enabled) return actual.runMainTrialSample(input)
      input.observe('writer', 'seed', () => undefined)
      input.observe('reader', 'seed', () => { throw new Error('injected reader failure') })
      throw new Error('the injected reader call must throw before this line')
    }
  }
})

let cellReport: CellReportModule
let lifecycle: LifecycleModule
beforeAll(async () => {
  cellReport = await import(new URL('./fixtures/concurrency-trace-main-cell-report.mjs', import.meta.url).href) as CellReportModule
  lifecycle = await import(new URL('./fixtures/concurrency-trace-live-lifecycle.mjs', import.meta.url).href) as LifecycleModule
})

const directories: string[] = []
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })

const factsWith = (control: MainTrialControlFacts | null): MainTrialFacts => ({
  runId: 'run-main-50k',
  k: MAIN_50K_FIXED_ITEMS,
  steps: WORKLOAD_STEPS.map((step, index) => ({ step, reply: index === 2 ? 'snapshot' : index === 0 ? 'snapshot' : 'delta', itemCount: MAIN_50K_STAGE_COUNTS[index], cursorCount: MAIN_50K_STAGE_COUNTS[index], changes: 1 })),
  finalItemCount: MAIN_50K_STAGE_COUNTS[MAIN_50K_STAGE_COUNTS.length - 1],
  observes: 7,
  merges: 7,
  oracle: 'checked',
  control
})

const measurement = (overrides: Partial<Measurement> = {}): Measurement => ({
  facts: factsWith(null),
  failure: null,
  phases: [{ step: 'seed', phase: 'writer', calls: 1, wallMs: 1, cpuUserUs: 2, cpuSystemUs: 3 }],
  overall: { wallMs: 10, cpuUserUs: 20, cpuSystemUs: 30 },
  memory: {
    before: { rssKb: 1, heapUsedKb: 2, heapTotalKb: 3, externalKb: 4 },
    after: { rssKb: 5, heapUsedKb: 6, heapTotalKb: 7, externalKb: 8 }
  },
  ...overrides
})

describe('50k trial report assembly', () => {
  it('keeps the collected evidence when a step throws', () => {
    const failure = { phase: 'oracle' as const, step: 'append' as const, error: 'delivered run differs from the independent literal-policy oracle after append' }
    const report = assembleReport({ controlRequested: null, measurement: measurement({ facts: null, failure, phases: [
      { step: 'seed', phase: 'writer', calls: 1, wallMs: 1, cpuUserUs: 2, cpuSystemUs: 3 },
      { step: 'seed', phase: 'oracle', calls: 1, wallMs: 4, cpuUserUs: 5, cpuSystemUs: 6 }
    ] }) })
    expect(report.status).toBe('failed')
    expect(report.failure).toEqual(failure)
    // Partial phase records and the after-memory snapshot survive the throw.
    expect(report.phases.map((sample) => sample.phase)).toEqual(['writer', 'oracle'])
    expect(report.phaseSum.wallMs).toBe(5)
    expect(report.unobservedMs).toBe(5)
    expect(report.memory.after.rssKb).toBe(5)
    expect(report.controlApplied).toBeNull()
  })

  it('cannot report a requested control as rejected when it never ran', () => {
    const report = assembleReport({ controlRequested: 'corrupt-body', measurement: measurement({ facts: factsWith(null) }) })
    expect(report.status).toBe('failed')
    expect(report.controlApplied).toBeNull()
    expect(report.failure?.error).toMatch(/was requested but never applied/)
  })

  it('reports an applied control as a failure that carries the oracle error', () => {
    const control: MainTrialControlFacts = { kind: 'corrupt-body', step: 'seed', rejected: true, oracleError: 'delivered run differs from the independent literal-policy oracle after negative control (corrupt-body) after seed' }
    const report = assembleReport({ controlRequested: 'corrupt-body', measurement: measurement({ facts: factsWith(control) }) })
    expect(report.status).toBe('failed')
    expect(report.controlApplied).toEqual(control)
    expect(report.failure).toMatchObject({ phase: 'oracle', step: 'seed' })
    expect(report.failure?.error).toContain('the independent oracle rejected it')
    expect(report.failure?.error).toContain(control.oracleError)
  })

  it('reports a healthy sample as measured with no control claim', () => {
    const report = assembleReport({ controlRequested: null, measurement: measurement() })
    expect(report.status).toBe('measured')
    expect(report.controlApplied).toBeNull()
    expect(report.failure).toBeNull()
    expect(report.boundary.phases).toMatch(/summed once into phaseSum beside overall and never added to it/)
  })
})

describe('50k trial timed sample failure path', () => {
  it('keeps partial phases, the failing operation and real after-memory when the sample throws', () => {
    trialFailure.enabled = true
    try {
      const result = runTimedSample()
      // Nothing is dressed up as a completed sample.
      expect(result.facts).toBeNull()
      expect(result.failure).toEqual({ phase: 'reader', step: 'seed', error: 'injected reader failure' })
      // Both observed calls were recorded before the throw, with real clock reads.
      expect(result.phases.map((sample) => `${sample.step}:${sample.phase}`)).toEqual(['seed:writer', 'seed:reader'])
      expect(result.phases.every((sample) => Number.isFinite(sample.wallMs) && Number.isFinite(sample.cpuUserUs))).toBe(true)
      expect(result.overall.wallMs).toBeGreaterThanOrEqual(0)
      expect(result.memory.before.rssKb).toBeGreaterThan(0)
      expect(result.memory.after.rssKb).toBeGreaterThan(0)
    } finally {
      trialFailure.enabled = false
    }
  })
})

// Deliberately permissive: these fixtures also build reports that must be refused (for example a control
// record with `rejected: false`), so the bad values have to be expressible without widening the production
// report contract.
const reportFile = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const report = assembleReport({ controlRequested: null, measurement: measurement() })
  return {
    ...report,
    runtime: { pid: 4242, electron: '1.2.3', node: '20.0.0', v8: '11.0', chrome: '120.0', platform: 'darwin', arch: 'arm64' },
    paths: { root: '/tmp/private' },
    windowFaults: [],
    ...overrides
  }
}

const write = (payload: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'scry-main-50k-report-'))
  directories.push(dir)
  const path = join(dir, 'result.json')
  writeFileSync(path, JSON.stringify(payload))
  return path
}

describe('50k trial report acceptance', () => {
  it('accepts a complete measured report', () => {
    const payload = cellReport.readReport(write(reportFile()))
    expect(payload.status).toBe('measured')
  })

  it('refuses a measured report without step facts', () => {
    expect(() => cellReport.readReport(write(reportFile({ facts: null })))).toThrow(/must carry step facts/)
  })

  it('refuses a measured report with an incomplete or miscounted sample', () => {
    const short = reportFile()
    const shortFacts = short.facts as MainTrialFacts
    short.facts = { ...shortFacts, steps: shortFacts.steps.slice(0, 6) }
    expect(() => cellReport.readReport(write(short))).toThrow(/not 7/)
    const miscounted = reportFile()
    const countedFacts = miscounted.facts as MainTrialFacts
    miscounted.facts = { ...countedFacts, steps: countedFacts.steps.map((step, index) => index === 1 ? { ...step, itemCount: step.itemCount + 1 } : step) }
    expect(() => cellReport.readReport(write(miscounted))).toThrow(/items, not/)
    const observers = reportFile()
    const observedFacts = observers.facts as MainTrialFacts
    observers.facts = { ...observedFacts, observes: 6 }
    expect(() => cellReport.readReport(write(observers))).toThrow(/observes, not 7/)
  })

  it('refuses a measured report that claims a control, a failure or a window fault', () => {
    expect(() => cellReport.readReport(write(reportFile({ controlRequested: 'corrupt-body' })))).toThrow(/never be measured/)
    expect(() => cellReport.readReport(write(reportFile({ failure: { phase: 'oracle', step: 'seed', error: 'x' } })))).toThrow(/must not carry a failure/)
    expect(() => cellReport.readReport(write({ ...reportFile(), windowFaults: ['a BrowserWindow was created'] }))).toThrow(/must not carry window faults/)
  })

  it('refuses a report with no real runtime evidence', () => {
    const payload = reportFile()
    payload.runtime = { pid: 0, electron: '', node: '20.0.0', v8: '11.0', chrome: '120.0', platform: 'darwin', arch: 'arm64' }
    expect(() => cellReport.readReport(write(payload))).toThrow(/no real process id/)
    const missing = reportFile()
    delete (missing as { runtime?: unknown }).runtime
    expect(() => cellReport.readReport(write(missing))).toThrow(/no real process id/)
  })

  it('refuses a failed report without its original text and a control run that never applied', () => {
    const control = reportFile({ status: 'failed', controlRequested: 'corrupt-body', controlApplied: null, failure: { phase: null, step: null, error: 'the corrupt-body control was requested but never applied, so it proved nothing' } })
    expect(() => cellReport.readReport(write(control))).toThrow(/never applied/)
    const silent = reportFile({ status: 'failed', failure: { phase: null, step: null, error: '' } })
    expect(() => cellReport.readReport(write(silent))).toThrow(/original failure text/)
    const fabricated = reportFile({ status: 'failed', controlApplied: { kind: 'corrupt-body', step: 'seed', rejected: false, oracleError: 'none' }, failure: { phase: null, step: null, error: 'x' } })
    expect(() => cellReport.readReport(write(fabricated))).toThrow(/without a rejected corrupt-body record/)
  })

  it('refuses a report for another workload', () => {
    expect(() => cellReport.readReport(write(reportFile({ k: 10_000 })))).toThrow(/not 50000/)
  })
})

describe('50k trial cleanup ownership', () => {
  const childClose = { wait: async () => ({ state: 'closed', code: 0, signal: null }) }
  const exitedInspection = () => ({ state: 'exited', root: { pid: 4242, exitCode: 0, signalCode: null }, descendants: 'unknown' })

  it('cannot report success when the trial exited before the owner captured it', async () => {
    const handle = lifecycle.ownedChild({
      name: 'main-50k',
      child: { pid: 4242, exitCode: 0, signalCode: null },
      childClose,
      inspect: exitedInspection,
      stopProcess: async () => { throw new Error('test App exited before ownership capture; descendant cleanup unknown') }
    })
    await handle.ready(async () => ({ started: true }))
    const record = await handle.shutdown('launcher:exit')
    expect(record.owned).toMatchObject({ status: 'failed' })
    const verdict = lifecycle.lifecycleVerdict([record])
    expect(verdict.ok).toBe(false)
    expect(verdict.issues.join()).toMatch(/exited before ownership capture/)
  })

  it('reports success only when the owner really stopped a captured tree', async () => {
    const handle = lifecycle.ownedChild({
      name: 'main-50k',
      child: { pid: 4243, exitCode: null, signalCode: null },
      childClose,
      inspect: exitedInspection,
      stopProcess: async () => ({ tracked: 3 })
    })
    await handle.ready(async () => ({ started: true }))
    const record = await handle.shutdown('launcher:notification')
    expect(record.owned).toMatchObject({ status: 'stopped' })
    expect(lifecycle.lifecycleVerdict([record])).toMatchObject({ ok: true, issues: [] })
  })
})
