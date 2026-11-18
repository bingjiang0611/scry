import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { configureRunStageTiming, recordRunStage, runStageTimingEnabled } from './run-stage-timing'

const directories: string[] = []
const temp = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'scry-run-timing-'))
  directories.push(directory)
  return directory
}
const read = (directory: string): Array<{ runId: string; stage: string; at: number; pid: number }> => {
  const text = readFileSync(join(directory, 'diagnostics', 'run-timing.ndjson'), 'utf8')
  return text.trim().split('\n').map((line) => JSON.parse(line))
}

afterEach(() => {
  delete process.env.SCRY_RUN_TIMING
  configureRunStageTiming(null)
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('run stage timing', () => {
  it('records nothing unless the measurement variable is set', () => {
    const directory = temp()
    configureRunStageTiming(directory)
    recordRunStage('run-a', 'providerStart')
    expect(runStageTimingEnabled()).toBe(false)
    expect(() => read(directory)).toThrow()
  })

  it('keeps the first mark of a stage and one absolute clock per mark', () => {
    const directory = temp()
    process.env.SCRY_RUN_TIMING = '1'
    configureRunStageTiming(directory)
    const before = performance.timeOrigin + performance.now()
    recordRunStage('run-a', 'providerStart')
    recordRunStage('run-a', 'providerStart')
    recordRunStage('run-a', 'firstOutput')
    recordRunStage('run-b', 'providerStart')
    const marks = read(directory)
    // Two stages for one run, then the other run: a repeat is a duplicate, not a sample.
    expect(marks.map((mark) => `${mark.runId}:${mark.stage}`)).toEqual(['run-a:providerStart', 'run-a:firstOutput', 'run-b:providerStart'])
    // The clock is epoch milliseconds in this process, so it can be subtracted from a
    // mark another process wrote about the same run.
    expect(marks[0].at).toBeGreaterThanOrEqual(before - 1)
    expect(marks[1].at).toBeGreaterThanOrEqual(marks[0].at)
    expect(marks[0].pid).toBe(process.pid)
  })
})
