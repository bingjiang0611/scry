import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const sum = values => values.reduce((total, value) => total + value, 0)
const mib = value => value / 1024 / 1024

// POSIX time includes the shell and its waited-for descendants, including native cat.
// Keep this separate from Node-only receipts; adding both would double-count the CLI.
export function summarizeHookTrees(entries) {
  let cpuMs = 0
  for (const entry of entries) {
    assert.equal(entry.code, 0, 'Hook process tree failed')
    const match = entry.stderr.match(/(?:^|\n)real\s+(\d+(?:\.\d+)?)\nuser\s+(\d+(?:\.\d+)?)\nsys\s+(\d+(?:\.\d+)?)\s*$/)
    assert.ok(match, 'Missing complete POSIX time receipt')
    cpuMs += (Number(match[2]) + Number(match[3])) * 1000
  }
  // Darwin time -p truncates user and sys independently to centiseconds.
  // Each field can lose <10 ms, so a tree can undercount CPU by <20 ms.
  return { status: 'measured', count: entries.length, cpuMs, maxRoundingErrorMs: entries.length * 20 }
}

// The current renderer consumes one selected run's scoped stream. A successful
// ACK proves that the production router accepted a post-commit batch receipt.
export function assertScopedDelivery(main, runId, startedAt, settledAt) {
  assert.ok(Array.isArray(main.scopedTrace), 'Scoped delivery was not collected')
  assert.equal(main.scopedTraceTruncated, false, 'Scoped delivery log exceeded its bound')
  const rows = main.scopedTrace.filter(row => row.at >= startedAt && row.at <= settledAt)
  const subscriptions = rows.filter(row => row.kind === 'subscribe' && row.status === 'subscribed' && row.runId === runId)
  assert.ok(subscriptions.length, 'Selected run needs a successful scoped snapshot')
  assert.ok(rows.some(row => row.kind === 'ack' && row.accepted === true && row.bytes > 0 &&
    subscriptions.some(subscription => subscription.subscriptionId === row.subscriptionId)),
  'Selected run needs an accepted post-commit batch receipt')
}

export function summarizeConcurrent(report) {
  assert.equal(report.schema, 1)
  const expectedHookStartsPerSession = report.workload?.expectedHookStartsPerSession ?? 42
  assert.ok([2, 42].includes(expectedHookStartsPerSession), 'Unsupported Hook receipt expectation')
  assert.equal(report.hooks.length, report.count * expectedHookStartsPerSession)
  assert.equal(report.canonicalRecords, report.count)
  const { startedAt, settledAt, main } = report
  if (main.hookTrees) assert.equal(main.hookTrees.length, report.count * 42, 'Every shell Hook needs a process-tree receipt')
  const samples = main.samples.filter(sample => sample.at >= startedAt && sample.at <= settledAt)
  assert.ok(samples.length >= 2, 'Not enough overlapping resource samples')
  const before = main.samples.filter(sample => sample.at <= startedAt).at(-1)
  const after = main.samples.find(sample => sample.at >= settledAt)
  assert.ok(before && after, 'Resource samples must bracket the measured operation')
  // The runner waits at least three seconds before requesting shutdown. Never use will-quit samples.
  const idleAfter = main.samples.filter(sample => sample.at >= settledAt + 2000 && sample.at <= settledAt + 2800).at(-1)
  assert.ok(idleAfter, 'Missing pre-shutdown idle memory sample')
  const elapsedMs = settledAt - startedAt
  const resourceWindowMs = after.at - before.at
  const counters = Object.fromEntries(Object.keys(after.counters).map(key => [key, after.counters[key] - before.counters[key]]))
  const processCpuMs = type => {
    const byPid = new Map()
    for (const sample of [before, ...samples, after]) {
      for (const process of sample.processes.filter(p => p.type === type)) {
        const usage = process.cpu.cumulativeCPUUsage
        if (typeof usage !== 'number') continue
        const entry = byPid.get(process.pid) ?? { first: usage, last: usage }
        entry.last = usage
        byPid.set(process.pid, entry)
      }
    }
    assert.ok(byPid.size, `No ${type} CPU samples`)
    return sum([...byPid.values()].map(entry => entry.last - entry.first)) * 1000
  }
  const peakWorkingSet = type => {
    const values = samples.flatMap(sample => sample.processes.filter(p => p.type === type)
      .map(p => p.memory?.workingSetSize).filter(value => typeof value === 'number'))
    return values.length ? Math.max(...values) / 1024 : null
  }
  const memory = sample => ({ mainRssMiB: mib(sample.rss), rendererWorkingSetMiB: sample.processes.filter(p => p.type === 'Tab')
    .map(p => p.memory?.workingSetSize / 1024) })
  const calls = main.ipc.filter(call => call.at >= startedAt && call.at <= settledAt)
  const hookCpuMs = sum(report.hooks.map(hook => (hook.cpu.user + hook.cpu.system) / 1000))
  return {
    count: report.count, elapsedMs, resourceWindowMs, samples: samples.length, animatedTitles: report.result?.ui?.animatedTitles,
    mainCpuMs: processCpuMs('Browser'), rendererCpuMs: processCpuMs('Tab'), gpuCpuMs: processCpuMs('GPU'),
    hookCpuMs, hookCpuMsPerStart: hookCpuMs / report.hooks.length,
    hookTree: main.hookTrees ? summarizeHookTrees(main.hookTrees) : { status: 'unavailable', reason: 'Whole Hook-tree accounting was not collected' },
    measuredCpuMs: processCpuMs('Browser') + processCpuMs('Tab') + processCpuMs('GPU') + hookCpuMs,
    mainCpuOneCorePct: processCpuMs('Browser') / resourceWindowMs * 100,
    peakMainRssMiB: mib(Math.max(...samples.map(sample => sample.rss))),
    peakRendererWorkingSetMiB: peakWorkingSet('Tab'),
    peakHookRssMiB: Math.max(...report.hooks.map(hook => hook.usage.maxRSS)) / 1024,
    idleBefore: memory(before), idleAfter: memory(idleAfter), idleAfterAt: idleAfter.at,
    maxIntervalEventLoopP95Ms: Math.max(...samples.map(sample => sample.eventLoopP95Ms)),
    maxEventLoopDelayMs: Math.max(...samples.map(sample => sample.eventLoopMaxMs)),
    counters, hookFsync: sum(report.hooks.map(hook => hook.counters.fsync)),
    hookGit: sum(report.hooks.map(hook => hook.counters.git)),
    activeRuns: { calls: calls.length, jsonBytes: sum(calls.map(call => call.jsonBytes)),
      maxConcurrent: Math.max(0, ...calls.map(call => call.runs)), handlerAndProbeMs: sum(calls.map(call => call.ms)) },
    scopedTrace: main.scopedTrace ? { status: 'measured',
      subscriptions: main.scopedTrace.filter(row => row.at >= startedAt && row.at <= settledAt && row.kind === 'subscribe' && row.status === 'subscribed').length,
      acceptedBatches: main.scopedTrace.filter(row => row.at >= startedAt && row.at <= settledAt && row.kind === 'ack' && row.accepted === true).length,
      acceptedPayloadBytes: sum(main.scopedTrace.filter(row => row.at >= startedAt && row.at <= settledAt && row.kind === 'ack' && row.accepted === true).map(row => row.bytes)),
      truncated: main.scopedTraceTruncated
    } : { status: 'unavailable', reason: 'Scoped delivery was not collected' },
    rendererMetrics: report.rendererMetrics, trace: report.trace?.complete ? report.trace : { status: 'unavailable', reason: 'Trace completion was not acknowledged' },
    canonicalRecords: report.canonicalRecords, archiveVerified: report.archiveVerified,
    highLoad: Math.max(report.initialLoad[0], report.finalLoad[0]) > report.cores,
    temp: report.temp, harnessHash: report.harnessHash
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(process.argv.slice(2).map(path => summarizeConcurrent(JSON.parse(readFileSync(path, 'utf8')))), null, 2))
}
