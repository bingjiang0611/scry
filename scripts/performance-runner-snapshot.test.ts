import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeRunnerProcesses, parseRunnerProcesses, runnerSnapshot } from './performance-runner-snapshot.mjs'
import { observeTimingEnvironment } from '../.agents/skills/scry-performance-climb/scripts/timing-observation.mjs'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), platform: vi.fn(() => 'darwin') }))
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.mocked(platform).mockReturnValue('darwin') })

const row = (pid: number, cpu = 12.5, time = '1:02.34') =>
  ` ${pid} 1 Fri Nov  6 03:12:34 2026 ${time} ${cpu} /private/fixture/Tool With Spaces`

describe('bounded Native runner diagnostics', () => {
  it('retains start identity and cumulative CPU without argv or private paths', () => {
    expect(parseRunnerProcesses(row(10))).toEqual([{ pid: 10, parentPid: 1, startedAt: 'Fri Nov 6 03:12:34 2026',
      cpuMs: 62340, psCpuPercent: 12.5, executable: 'Tool With Spaces' }])
    expect(parseRunnerProcesses(row(10, 0, '1-02:03:04'))[0].cpuMs).toBe(93784000)
    expect(() => parseRunnerProcesses('/private/sensitive invalid line')).toThrow('Unrecognized ps process record')
    expect(() => parseRunnerProcesses(row(10, 0, 'invalid'))).toThrow('Unrecognized ps CPU time')
  })

  it('bounds output and marks omitted processes rather than claiming complete coverage', () => {
    vi.mocked(execFileSync).mockReturnValue(Array.from({ length: 40 }, (_, i) => row(i + 1, i)).join('\n'))
    const snapshot = runnerSnapshot('before-native')
    expect(snapshot).toMatchObject({ status: 'available', processCount: 40, processLimit: 32, truncated: true })
    expect(snapshot.processes).toHaveLength(32)
    expect(snapshot.processes[0].pid).toBe(40)
    expect(JSON.stringify(snapshot)).not.toContain('/private/')
    expect(execFileSync).toHaveBeenCalledWith('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,time=,pcpu=,comm=', '-ww'],
      expect.objectContaining({ timeout: 2000, maxBuffer: 2 * 1024 * 1024, env: expect.objectContaining({ LC_ALL: 'C' }) }))
  })

  it('reports collection failure and unsupported platforms as unavailable, not zero', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error('/private/sensitive failure'), { code: 'EACCES' }) })
    expect(runnerSnapshot('after-native')).toMatchObject({ status: 'unavailable', operation: 'collect', code: 'EACCES' })
    expect(JSON.stringify(runnerSnapshot('after-native'))).not.toContain('/private/')
    vi.mocked(execFileSync).mockReturnValue('/private/sensitive malformed record')
    expect(runnerSnapshot('malformed')).toMatchObject({ status: 'unavailable', operation: 'parse' })
    expect(runnerSnapshot('malformed')).not.toHaveProperty('processes')
    vi.mocked(execFileSync).mockClear()
    vi.mocked(platform).mockReturnValue('linux')
    expect(runnerSnapshot('unsupported')).toMatchObject({ status: 'unavailable' })
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('does not sample processes during ordinary timing runs; explicit profiles retain bounded evidence', () => {
    vi.useFakeTimers()
    vi.stubEnv('SCRY_TIMING_PROCESS_SNAPSHOTS', '')
    expect(observeTimingEnvironment()()).not.toHaveProperty('processSnapshots')
    expect(execFileSync).not.toHaveBeenCalled()
    vi.mocked(execFileSync).mockReturnValue(row(10))
    vi.stubEnv('SCRY_TIMING_PROCESS_SNAPSHOTS', '1')
    const finish = observeTimingEnvironment()
    vi.advanceTimersByTime(3000)
    const result = finish()
    expect(result.processSnapshots.snapshots).toHaveLength(5)
    expect(result.processSnapshots.truncated).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('caps process samples and stops collection after an unavailable observation', () => {
    vi.useFakeTimers()
    vi.mocked(execFileSync).mockReturnValue(row(10))
    const finish = observeRunnerProcesses()
    vi.advanceTimersByTime(200_000)
    const result = finish()
    expect(result.snapshots).toHaveLength(128)
    expect(result.truncated).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.mocked(execFileSync).mockClear()
    const failed = observeRunnerProcesses()
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('denied') })
    vi.advanceTimersByTime(5000)
    expect(failed().snapshots.map(snapshot => snapshot.status)).toEqual(['available', 'unavailable'])
    expect(execFileSync).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps snapshots outside the unchanged primary measurement and comparison', () => {
    const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }
    const workflow = load(readFileSync('.github/workflows/performance.yml', 'utf8')) as {
      jobs: { native: { steps: { name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }[] } }
    }
    const steps = workflow.jobs.native.steps
    const before = steps.findIndex(step => step.name === 'Observe runner processes before Native measurements')
    const measure = steps.findIndex(step => step.name === 'Measure baseline then candidate, retaining failures')
    const after = steps.findIndex(step => step.name === 'Observe runner processes after Native measurements')
    const compare = steps.findIndex(step => step.name === 'Compare native evidence and budgets')
    expect(before).toBeGreaterThan(-1)
    expect([before + 1, measure + 1, after + 1]).toEqual([measure, after, compare])
    expect(steps[before]['continue-on-error']).toBe(true)
    expect(steps[after]['continue-on-error']).toBe(true)
    expect(steps[after].if).toBe('always()')
    expect(steps[measure]['continue-on-error']).toBeUndefined()
    expect(steps[compare]['continue-on-error']).toBeUndefined()
    const profile = steps.find(step => step.name === 'Profile runner processes in one separate manual diagnostic')!
    expect(profile.if).toBe("always() && github.event_name == 'workflow_dispatch' && steps.native_measurements.outcome == 'success'")
    expect(profile['continue-on-error']).toBe(true)
    expect(profile.run).toContain('runner-profile.json')
    expect(profile.run).not.toContain(' compare ')
    expect(steps[measure].run).not.toContain('snapshot')
    expect(steps[measure].run).not.toContain('runner-profile')
    expect(steps[compare].run).toBe('node candidate/scripts/performance-native-run.mjs compare native-results/baseline.json native-results/candidate.json native-results/report.md')
  })
})
