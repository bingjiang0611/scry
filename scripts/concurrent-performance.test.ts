import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { summarizeConcurrent, summarizeHookTrees, assertScopedDelivery } from './concurrent-performance-summary.mjs'

describe('concurrent performance measurement', () => {
  it('counts real fsync and git calls, with a zero-work negative control', () => {
    const temp = mkdtempSync(join(tmpdir(), 'scry-concurrent-probe-test-'))
    try {
      const run = (work: boolean) => {
        const log = join(temp, `probe-${work}.jsonl`)
        execFileSync(process.execPath, ['--require', resolve('scripts/concurrent-performance-probe.cjs'), '-e', `
          (async () => {
            if (!${work}) return;
            const { open } = require('node:fs/promises');
            const file = await open(${JSON.stringify(join(temp, 'payload'))}, 'w');
            await file.writeFile('real payload'); await file.sync(); await file.close();
            const directory = await open(${JSON.stringify(temp)}, 'r'); await directory.sync(); await directory.close();
            require('node:child_process').execFileSync('git', ['--version']);
            require('node:child_process').spawnSync('git', { cwd: ${JSON.stringify(temp)}, stdio: 'ignore' });
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `], { env: { ...process.env, SCRY_CONCURRENT_ROLE: 'hook', SCRY_CONCURRENT_LOG: log } })
        return JSON.parse(readFileSync(log, 'utf8'))
      }
      expect(run(false).counters).toMatchObject({ fsync: 0, git: 0, children: 0 })
      const measured = run(true)
      expect(measured.counters).toMatchObject({ fsync: 2, git: 2, children: 2 })
      expect(measured.gitCalls).toEqual([
        { at: expect.any(Number), argv: ['git', '--version'] },
        { at: expect.any(Number), argv: ['git'], cwd: temp }
      ])
      expect(measured.gitCallsTruncated).toBe(false)
      expect(measured.usage.maxRSS).toBeGreaterThan(0)
      expect(measured.cpu.user + measured.cpu.system).toBeGreaterThan(0)
    } finally { rmSync(temp, { recursive: true, force: true }) }
  })

  const fixture = () => {
    const sample = (at: number, cpu: number, fsync: number) => ({
      at, rss: 64 * 1024 * 1024, cpu: { user: cpu, system: 0 }, counters: { fsync, git: 0 },
      eventLoopP95Ms: 11, eventLoopMaxMs: 20,
      processes: ['Browser', 'Tab', 'GPU'].map((type, pid) => ({ type, pid, cpu: { cumulativeCPUUsage: cpu }, memory: { workingSetSize: 1024 } }))
    })
    return { schema: 1, count: 1, startedAt: 1000, settledAt: 2000, canonicalRecords: 1, archiveVerified: true,
      initialLoad: [1], finalLoad: [1], cores: 8, main: { samples: [sample(900, 0, 0), sample(1200, 0.1, 1), sample(1700, 0.2, 2), sample(2100, 0.3, 3), sample(4500, 0.3, 3), { ...sample(5500, 0.3, 3), rss: 0, processes: [] }],
        ipc: [{ at: 1500, runs: 1, jsonBytes: 1024, ms: 2 }] },
      hooks: Array.from({ length: 42 }, () => ({ cpu: { user: 1000, system: 1000 }, usage: { maxRSS: 1024 }, counters: { fsync: 2, git: 0 } })) }
  }

  it('uses cumulative CPU deltas and reports JSON bytes without calling them wire bytes', () => {
    const result = summarizeConcurrent(fixture())
    expect(result.mainCpuMs).toBe(300)
    expect(result.hookCpuMs).toBe(84)
    expect(result.measuredCpuMs).toBe(984)
    expect(result.counters.fsync).toBe(3)
    expect(result.hookFsync).toBe(84)
    expect(result.activeRuns).toEqual({ calls: 1, jsonBytes: 1024, maxConcurrent: 1, handlerAndProbeMs: 2 })
    expect(result.peakMainRssMiB).toBe(64)
    expect(result.peakHookRssMiB).toBe(1)
    expect(result.idleAfter.mainRssMiB).toBe(64)
    expect(result.idleAfterAt).toBe(4500)
    expect(result.trace.status).toBe('unavailable')
    expect(result.highLoad).toBe(false)
  })

  it('requires an explicit lifecycle-only expectation and still rejects missing receipts', () => {
    const report = { ...fixture(), workload: { expectedHookStartsPerSession: 2 } }
    report.hooks = report.hooks.slice(0, 2)
    expect(summarizeConcurrent(report).hookCpuMs).toBe(4)
    expect(() => summarizeConcurrent({ ...report, workload: undefined })).toThrow()
    report.hooks.pop()
    expect(() => summarizeConcurrent(report)).toThrow()
    expect(() => summarizeConcurrent({ ...report, hooks: [], workload: { expectedHookStartsPerSession: 0 } })).toThrow('expectation')
  })

  it('accounts for whole Hook trees without double-counting Node CPU and rejects incomplete timing receipts', () => {
    const entry = { code: 0, stderr: 'CLI diagnostics\nreal 0.42\nuser 0.12\nsys 0.03\n' }
    expect(summarizeHookTrees([entry, entry])).toEqual({ status: 'measured', count: 2, cpuMs: 300, maxRoundingErrorMs: 40 })
    expect(() => summarizeHookTrees([{ ...entry, code: 1 }])).toThrow('failed')
    expect(() => summarizeHookTrees([{ ...entry, stderr: 'real 0.42\n' }])).toThrow('receipt')
    const missingTree = { ...fixture(), main: { ...fixture().main, hookTrees: [entry] } }
    expect(() => summarizeConcurrent(missingTree)).toThrow('Every shell Hook')
  })

  it('bounds the independent user and sys centisecond truncation in Darwin time receipts', () => {
    const result = summarizeHookTrees([{ code: 0, stderr: 'real 0.02\nuser 0.00\nsys 0.00\n' }])
    const lossPerFieldMs = 9999 / 1000
    expect(result.cpuMs).toBe(0)
    expect(result.maxRoundingErrorMs).toBeGreaterThan(2 * lossPerFieldMs)
    expect(result.maxRoundingErrorMs).toBe(20)
  })

  it('requires a selected-run snapshot and an accepted post-commit receipt, not legacy polling', () => {
    const main = { scopedTraceTruncated: false, ipc: [], scopedTrace: [
      { at: 1100, kind: 'subscribe', status: 'subscribed', subscriptionId: 'sub-1', runId: 'run-1' },
      { at: 1200, kind: 'ack', subscriptionId: 'sub-1', accepted: true, bytes: 64 }
    ] }
    expect(() => assertScopedDelivery(main, 'run-1', 1000, 2000)).not.toThrow()
    expect(() => assertScopedDelivery(main, 'other-run', 1000, 2000)).toThrow('snapshot')
    expect(() => assertScopedDelivery(main, 'run-1', 1300, 2000)).toThrow('snapshot')
    expect(() => assertScopedDelivery({ ...main, scopedTraceTruncated: true }, 'run-1', 1000, 2000)).toThrow('bound')
    for (const ack of [
      { ...main.scopedTrace[1], accepted: false },
      { ...main.scopedTrace[1], subscriptionId: 'foreign-sub' },
      { ...main.scopedTrace[1], bytes: 0 },
      { ...main.scopedTrace[1], at: 2100 }
    ]) {
      expect(() => assertScopedDelivery({ ...main, scopedTrace: [main.scopedTrace[0], ack] }, 'run-1', 1000, 2000)).toThrow('receipt')
    }
  })

  it('keeps uncollected scoped delivery unavailable and separates accepted payload bytes from JSON bytes', () => {
    expect(summarizeConcurrent(fixture()).scopedTrace.status).toBe('unavailable')
    const report = fixture()
    report.main.scopedTraceTruncated = false
    report.main.scopedTrace = [
      { at: 1100, kind: 'subscribe', status: 'subscribed' },
      { at: 1200, kind: 'ack', accepted: true, bytes: 64 },
      { at: 1300, kind: 'ack', accepted: false, bytes: 128 },
      { at: 2500, kind: 'ack', accepted: true, bytes: 256 }
    ]
    expect(summarizeConcurrent(report).scopedTrace).toEqual({ status: 'measured', subscriptions: 1,
      acceptedBatches: 1, acceptedPayloadBytes: 64, truncated: false })
  })

  it('rejects missing Hook receipts and unbracketed measurement windows', () => {
    const missingHook = fixture()
    missingHook.hooks.pop()
    expect(() => summarizeConcurrent(missingHook)).toThrow()
    const missingBoundary = fixture()
    missingBoundary.main.samples.shift()
    expect(() => summarizeConcurrent(missingBoundary)).toThrow('bracket')
  })
})
