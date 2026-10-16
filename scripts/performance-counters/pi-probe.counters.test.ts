import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'
import { withProbeFixture } from '../../src/main/providers/pi-rpc.fixture'
import { probePiAgent } from '../../src/main/providers/pi'

const meter = vi.hoisted(() => ({
  active: false, spawned: 0, spawnedAt: 0, closedAt: 0, graceExpiries: 0,
  responses: {} as Record<string, number>, args: [] as string[]
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
        if (frame.type === 'response') meter.responses[frame.command] = performance.now()
      })
      child.once('close', () => { meter.closedAt = performance.now() })
    }
    return child
  } }
})

const workload = 'offline-readonly-rpc=1;queries=4;eof-idle-handle=1;probe=1'
const source = 'production probe with shared offline RPC fixture; passive stdio/close observation and pass-through shutdown timer expiry counter'

describe('Pi capability probe work and phases', () => {
  it('preserves all four responses and confirms graceful child exit, including an idle handle after EOF', async () => {
    const samples: Array<{
      environmentMs: number; firstResponseMs: number; responseBurstMs: number; shutdownMs: number;
      postCloseMs: number; totalMs: number; responsesMs: Record<string, number>
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
          Object.assign(meter, { spawned: 0, spawnedAt: 0, closedAt: 0, graceExpiries: 0, responses: {}, args: [] })
          meter.active = true
          const started = performance.now()
          let result: Awaited<ReturnType<typeof probePiAgent>>
          try { result = await probePiAgent(profile, cwd) } finally { meter.active = false }
          const finished = performance.now()
          expect(result.models).toEqual([])
          expect(result.levels).toEqual(['off'])
          expect(result.commands).toEqual([{ name: 'fixture-menu', source: 'extension' }])
          expect(starts()).toEqual([cwd])
          expect(meter.args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--offline', '--no-session']))
          expect(readFileSync(join(cwd, 'commands'), 'utf8').trim().split('\n').sort()).toEqual([
            'get_available_models', 'get_available_thinking_levels', 'get_commands', 'get_state'
          ])
          expect(readFileSync(join(cwd, 'probe-closed'), 'utf8')).toBe('graceful')
          const pid = Number(readFileSync(join(cwd, 'pid'), 'utf8'))
          expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
          const responses = Object.values(meter.responses)
          expect(responses).toHaveLength(4)
          const first = Math.min(...responses)
          const last = Math.max(...responses)
          expect(meter.closedAt).toBeGreaterThanOrEqual(last)
          samples.push({
            environmentMs: meter.spawnedAt - started,
            firstResponseMs: first - meter.spawnedAt,
            responseBurstMs: last - first,
            shutdownMs: meter.closedAt - last,
            postCloseMs: finished - meter.closedAt,
            totalMs: finished - started,
            responsesMs: Object.fromEntries(Object.entries(meter.responses).map(([command, at]) => [command, at - meter.spawnedAt]))
          })
          counters = { processes: meter.spawned, requests: responses.length, expiries: meter.graceExpiries }
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
