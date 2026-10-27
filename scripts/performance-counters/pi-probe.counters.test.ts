import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'
import { withProbeFixture } from '../../src/main/providers/pi-rpc.fixture'
import { disposePiCatalog } from '../../src/main/providers/pi-catalog'
import { probePiAgent } from '../../src/main/providers/pi'

const meter = vi.hoisted(() => ({
  active: false, spawned: 0, spawnedAt: 0, closedAt: 0, graceExpiries: 0,
  responses: 0, firstResponseAt: 0, lastResponseAt: 0, args: [] as string[]
}))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const started = performance.now()
    const child = actual.spawn(...args)
    if (meter.active && args[1]?.includes('rpc')) {
      meter.spawned++
      meter.spawnedAt = started
      meter.args = [...args[1]]
      if (child.stdout) createInterface({ input: child.stdout }).on('line', line => {
        const frame = JSON.parse(line) as { type: string; command: string }
        if (frame.type === 'response') {
          if (meter.responses === 0) meter.firstResponseAt = performance.now()
          meter.responses++
          meter.lastResponseAt = performance.now()
        }
      })
      child.once('close', () => { meter.closedAt = performance.now() })
    }
    return child
  } }
})

// Two catalog reads share one offline RPC child: the second read is answered by the parked process,
// and the child is closed on dispose instead of at the end of each read.
const workload = 'offline-readonly-rpc=1;probes=2;queries=8;eof-idle-handle=1;parked-process=1'
const source = 'production probe with shared offline RPC fixture; passive stdio/close observation and pass-through shutdown timer expiry counter'

describe('Pi capability probe work and phases', () => {
  it('reuses one child for two catalog reads and closes it on dispose, including an idle handle after EOF', async () => {
    const samples: Array<{
      environmentMs: number; firstResponseMs: number; responseBurstMs: number; shutdownMs: number;
      postCloseMs: number; totalMs: number
    }> = []
    const originalTimeout = globalThis.setTimeout
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (!meter.active || delay !== 750) return originalTimeout(callback, delay, ...args)
      return originalTimeout((...params) => { meter.graceExpiries++; callback(...params) }, delay, ...args)
    })
    try {
      const runs = await repeatCounters(defaultRepeats, async () => {
        let counters!: { processes: number; requests: number; expiries: number }
        await withProbeFixture(async (profile, cwd, starts) => {
          writeFileSync(join(cwd, 'probe-idle'), '')
          Object.assign(meter, { spawned: 0, spawnedAt: 0, closedAt: 0, graceExpiries: 0, responses: 0, firstResponseAt: 0, lastResponseAt: 0, args: [] })
          meter.active = true
          const started = performance.now()
          let result: Awaited<ReturnType<typeof probePiAgent>>
          try {
            result = await probePiAgent(profile, cwd)
            await probePiAgent(profile, cwd)
          } finally { meter.active = false }
          expect(result.models).toEqual([])
          expect(result.levels).toEqual(['off'])
          expect(result.commands).toEqual([{ name: 'fixture-menu', source: 'extension' }])
          // The second read reuses the parked child: one spawn, eight answers.
          expect(starts()).toEqual([cwd])
          expect(meter.spawned).toBe(1)
          expect(meter.responses).toBe(8)
          expect(meter.args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--offline', '--no-session']))
          expect(readFileSync(join(cwd, 'commands'), 'utf8').trim().split('\n').sort()).toEqual([
            'get_available_models', 'get_available_thinking_levels', 'get_commands', 'get_state',
            'get_available_models', 'get_available_thinking_levels', 'get_commands', 'get_state'
          ].sort())
          await disposePiCatalog()
          const closedAt = performance.now()
          expect(readFileSync(join(cwd, 'probe-closed'), 'utf8')).toBe('graceful')
          const pid = Number(readFileSync(join(cwd, 'pid'), 'utf8'))
          expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
          expect(meter.closedAt).toBeGreaterThanOrEqual(meter.lastResponseAt)
          samples.push({
            environmentMs: meter.spawnedAt - started,
            firstResponseMs: meter.firstResponseAt - meter.spawnedAt,
            responseBurstMs: meter.lastResponseAt - meter.firstResponseAt,
            shutdownMs: meter.closedAt - meter.lastResponseAt,
            postCloseMs: closedAt - meter.closedAt,
            totalMs: closedAt - started
          })
          counters = { processes: meter.spawned, requests: meter.responses, expiries: meter.graceExpiries }
        })
        return counters
      })
      writeCollector('pi-probe', [
        measured({ scenario: 'providers.pi-probe', metric: 'subprocess.rpc', layer: 'main', unit: 'count', workload, source }, runs.processes),
        measured({ scenario: 'providers.pi-probe', metric: 'rpc.responses', layer: 'main', unit: 'count', workload, source }, runs.requests),
        measured({ scenario: 'providers.pi-probe', metric: 'shutdown.grace-expiries', layer: 'main', unit: 'count', workload, source }, runs.expiries)
      ])
      if (process.env.SCRY_PI_PROBE_TIMINGS) writeFileSync(process.env.SCRY_PI_PROBE_TIMINGS, JSON.stringify({ workload, samples }, null, 2))
    } finally { meter.active = false; timer.mockRestore() }
  }, 120_000)
})
