import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeTimingEnvironment } from '../.agents/skills/scry-performance-climb/scripts/timing-observation.mjs'

const ticks = vi.hoisted(() => ({ user: 0, idle: 0 }))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  cpus: () => [{ times: { user: ticks.user, idle: ticks.idle, sys: 0, nice: 0, irq: 0 } }]
}))
afterEach(() => { vi.useRealTimers(); ticks.user = 0; ticks.idle = 0 })

const script = pathToFileURL(resolve('.agents/skills/scry-performance-climb/scripts/timing-observation.mjs')).href

describe('timing parent diagnostics', () => {
  it('reports CPU deltas and leaves an unsampled event-loop histogram unknown', () => {
    const finish = observeTimingEnvironment()
    ticks.user = 50
    ticks.idle = 50
    const result = finish()
    expect(result.samples).toHaveLength(1)
    expect(result.samples[0].cpuBusyPercent).toBe(50)
    expect(result.samples[0].eventLoopMaxMs).toBeNull()
    expect(result.maxEventLoopDelayMs).toBeNull()
    expect(result.samplesTruncated).toBe(false)
  })

  it('does not report zero CPU activity when no CPU clock tick was observed', () => {
    const result = observeTimingEnvironment()()
    expect(result.samples[0].cpuBusyPercent).toBeNull()
  })

  it('bounds retained samples and marks omitted later observations', () => {
    vi.useFakeTimers()
    const finish = observeTimingEnvironment()
    try {
      vi.advanceTimersByTime(250 * 4097)
    } finally {
      const result = finish()
      expect(result.samples).toHaveLength(result.sampleLimit)
      expect(result.samplesTruncated).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('drains a large diagnostic footer through tee and preserves the child failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scry-timing-output-'))
    try {
      const wrapper = readFileSync('.agents/skills/scry-performance-climb/scripts/timing-run.mjs', 'utf8')
      const lockDeclaration = "const lock = '/tmp/scry-performance-timing.lock'"
      expect(wrapper).toContain(lockDeclaration)
      // Exercise the real output/exit path with a private lock and a full-size
      // observation fixture, without occupying the host's measurement lock for 17 minutes.
      writeFileSync(join(directory, 'timing-run.mjs'), wrapper.replace(lockDeclaration,
        `const lock = ${JSON.stringify(join(directory, 'lock'))}`))
      writeFileSync(join(directory, 'timing-observation.mjs'), `
        export const observeTimingEnvironment = () => () => ({samples:
          Array.from({length:4096}, () => ({sampledAt:'2026-11-06T00:00:00.000Z',
            cpuBusyPercent:12.3456789,eventLoopMaxMs:20.1234567}))})
      `)
      const output = join(directory, 'output.log')
      const result = spawnSync('bash', ['-o', 'pipefail', '-c',
        '"$1" "$2" diagnostic-pipe -- "$1" -e "process.exit(7)" | tee "$3"',
        'scry-timing-test', process.execPath, join(directory, 'timing-run.mjs'), output
      ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
      expect(result.status, result.stderr).toBe(7)
      expect(result.stdout.length).toBeGreaterThan(300_000)
      const footer = JSON.parse(result.stdout.trim().slice('SCRY_TIMING_RUN='.length))
      expect(footer.exit).toBe(7)
      expect(footer.diagnostics.samples).toHaveLength(4096)
      expect(readFileSync(output, 'utf8')).toBe(result.stdout)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('negative control: records a deliberate event-loop stall in an isolated process', async () => {
    // Prime/drain the real Node histogram around a known non-yielding interval.
    // This is a detector test, not a latency claim or a wait for a quiet machine.
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
      import { setTimeout } from 'node:timers/promises'
      import { observeTimingEnvironment } from ${JSON.stringify(script)}
      const finish = observeTimingEnvironment()
      await setTimeout(40)
      const until = performance.now() + 120
      while (performance.now() < until) {}
      await setTimeout(40)
      console.log(JSON.stringify(finish()))
    `])
    const result = JSON.parse(stdout)
    expect(result.maxEventLoopDelayMs).toBeGreaterThanOrEqual(100)
    expect(result.samples.length).toBeGreaterThan(0)
    expect(result.samplesTruncated).toBe(false)
  })
})
