import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compareObservations, filterObservations, parseArgs } from './performance-measure.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const observation = (metric: string, value: number, extra: Record<string, unknown> = {}) => ({
  scenario: 'trace.delivery', metric, layer: 'ipc', unit: 'count', workload: 'trace-events=1000;unicode=true', source: 'test',
  availability: 'measured', runs: [value, value], ...extra
})

describe('performance measurement tool', () => {
  it('parses filters, comparison, repeats, profile and output options', () => {
    expect(parseArgs(['--scenario', 'trace.delivery', '--layer', 'ipc', '--compare', 'HEAD', '--repeats', '7', '--profile', '--out', '/tmp/result'])).toEqual({
      scenario: 'trace.delivery', layer: 'ipc', compare: 'HEAD', repeats: 7, profile: true, out: '/tmp/result'
    })
    expect(() => parseArgs(['--layer', 'renderer'])).toThrow(/Unknown layer/)
    expect(() => parseArgs(['--repeats', '0'])).toThrow(/positive/)
  })

  it('filters observations without changing their measured values', () => {
    const report = { schema: 1 as const, revision: 'test', observations: [observation('ipc.messages', 2), { ...observation('ipc.bytes', 10), layer: 'io', unit: 'bytes' }] }
    expect(filterObservations(report, { scenario: 'trace.delivery', layer: 'ipc' }).observations).toEqual([report.observations[0]])
  })

  it('calculates integer deltas and percentages from conservative repeated values', () => {
    const baseline = { schema: 1 as const, revision: 'base', observations: [observation('ipc.messages', 4)] }
    const candidate = { schema: 1 as const, revision: 'head', observations: [observation('ipc.messages', 5)] }
    expect(compareObservations(baseline, candidate)[0]).toMatchObject({ baseline: 4, candidate: 5, delta: 1, percent: 25 })
  })

  it('compares HEAD with the reference trace collector and cleans up its detached worktree', () => {
    const output = mkdtempSync(join(tmpdir(), 'scry-performance-measure-test-'))
    try {
      execFileSync(process.execPath, [join(root, 'scripts/performance-measure.mjs'), '--compare', 'HEAD', '--scenario', 'trace.delivery', '--repeats', '5', '--out', output], { cwd: root, encoding: 'utf8' })
      const result = JSON.parse(readFileSync(join(output, 'measure.json'), 'utf8'))
      expect(result.comparisons).toHaveLength(2)
      expect(result.comparisons.every((row: { baseline: number, candidate: number, delta: number }) => row.baseline === row.candidate && row.delta === 0)).toBe(true)
      expect(result.worktreeCleanup.listedAfterCleanup).not.toContain(result.worktreeCleanup.worktree)
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  }, 120_000)
})
