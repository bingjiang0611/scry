import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { captureProcessIdentity, defaultProcessLister } from './process-diagnostics'

interface Measurement {
  provider: 'claude' | 'qoder'
  samplesMs: number[]
  psCalls: number
}

async function measureSpawnIdentity(provider: Measurement['provider']): Promise<{ durationMs: number; psCalls: number }> {
  void provider
  const child = spawn('/bin/sh', ['-c', 'sleep 2'], { detached: true, stdio: 'ignore' })
  let psCalls = 0
  const startedAt = performance.now()
  try {
    const identity = captureProcessIdentity(child.pid, () => {
      psCalls += 1
      return defaultProcessLister()
    })
    const resolved = await Promise.resolve(identity)
    expect(resolved?.pid).toBe(child.pid)
    expect(resolved?.startedAt).toBeTruthy()
    return { durationMs: performance.now() - startedAt, psCalls }
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ }
  }
}

describe('A1 process identity baseline measurement', () => {
  it('counts one full-table ps lookup for controlled Claude and Qoder spawn equivalents', async () => {
    const measurements: Measurement[] = []
    for (const provider of ['claude', 'qoder'] as const) {
      const samplesMs: number[] = []
      let psCalls = 0
      for (let sample = 0; sample < 3; sample += 1) {
        const result = await measureSpawnIdentity(provider)
        samplesMs.push(Number(result.durationMs.toFixed(3)))
        psCalls += result.psCalls
      }
      measurements.push({ provider, samplesMs, psCalls })
    }

    for (const measurement of measurements) {
      expect(measurement.psCalls).toBe(3)
    }
    console.log(`A1 baseline ${JSON.stringify({ command: 'captureProcessIdentity at controlled Claude/Qoder spawn', measurements })}`)
  }, 20_000)
})
