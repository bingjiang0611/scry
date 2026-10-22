import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

interface ProcessCall {
  kind: 'execFile' | 'execFileSync'
  executable: string
  argv: string[]
  scope: 'full-table' | 'target'
  rows: number
}

const calls = vi.hoisted(() => ({ process: [] as ProcessCall[] }))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const record = (kind: ProcessCall['kind'], args: unknown[], output: unknown): void => {
    const executable = String(args[0])
    const argv = Array.isArray(args[1]) ? args[1].map(String) : []
    const scope = argv.includes('-p') ? 'target' : argv.includes('-axo') ? 'full-table' : undefined
    if (!scope) return
    const rows = String(output).split('\n').filter((line) => line.trim()).length
    calls.process.push({ kind, executable, argv, scope, rows })
  }
  const execFileSync = ((...args: unknown[]) => {
    const output = actual.execFileSync(...args as Parameters<typeof actual.execFileSync>)
    record('execFileSync', args, output)
    return output
  }) as typeof actual.execFileSync
  const execFile = ((...args: unknown[]) => {
    const callback = args.at(-1)
    if (typeof callback !== 'function') return actual.execFile(...args as Parameters<typeof actual.execFile>)
    const wrapped = (error: Error | null, stdout: string, stderr: string): void => {
      if (!error) record('execFile', args, stdout)
      callback(error, stdout, stderr)
    }
    return actual.execFile(...args.slice(0, -1).concat(wrapped) as Parameters<typeof actual.execFile>)
  }) as typeof actual.execFile
  return { ...actual, execFile, execFileSync }
})

import { captureProcessIdentity } from './process-diagnostics'

interface Measurement {
  provider: 'claude' | 'qoder'
  samples: number
  calls: ProcessCall[]
}

async function collect(provider: Measurement['provider']): Promise<Measurement> {
  const providerStart = calls.process.length
  for (let sample = 0; sample < 3; sample += 1) {
    const child = spawn('/bin/sh', ['-c', 'sleep 2'], { detached: true, stdio: 'ignore' })
    try {
      const identity = await Promise.resolve(captureProcessIdentity(child.pid))
      expect(identity?.pid).toBe(child.pid)
      expect(identity?.startedAt).toBeTruthy()
    } finally {
      const exited = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once('exit', () => resolve()))
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ }
      await exited
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    }
  }
  return { provider, samples: 3, calls: calls.process.slice(providerStart) }
}

describe('A1 process identity measurement', () => {
  it('counts the actual default capture command for Claude and Qoder spawn equivalents', async () => {
    calls.process.length = 0
    const measurements = [await collect('claude'), await collect('qoder')]
    expect(measurements).toHaveLength(2)
    expect(measurements.every(({ samples, calls: sampleCalls }) => samples === 3 && sampleCalls.length === 3)).toBe(true)
    expect(calls.process.every(({ rows }) => rows > 0)).toBe(true)
    expect(new Set(calls.process.map(({ scope }) => scope)).size).toBe(1)
    console.log(`A1 collector ${JSON.stringify({
      command: 'captureProcessIdentity default',
      measurements: measurements.map(({ provider, samples, calls: sampleCalls }) => ({ provider, samples, calls: sampleCalls }))
    })}`)
  }, 20_000)
})
