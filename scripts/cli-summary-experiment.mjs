#!/usr/bin/env node
// Informational, not a gate. Run under timing-run.mjs after build:cli.
// Counts use observed OrderedCall.record reads; timings never use instrumentation.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const output = process.argv[2]
assert(output, 'usage: node scripts/cli-summary-experiment.mjs <output.json>')
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = join(root, 'packages/turn-recorder-cli/dist/core/turn-recorder/turns-summary.js')
const { summarizeTurnRecords } = await import(pathToFileURL(bundle).href)
const { validateAgentTurnRecord } = await import(pathToFileURL(join(root, 'packages/turn-recorder-cli/dist/shared/turn-record.js')).href)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const available = value => ({ status: 'available', quality: 'exact', source: ['fixture'], value })
const unavailable = () => ({ status: 'unavailable', quality: 'unavailable', source: [] })
const callsPerRecord = 18
function fixture(count) {
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1
    const startedAt = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString()
    const completedAt = new Date(Date.UTC(2026, 0, 1) + (index + 1) * 1000).toISOString()
    const tools = Array.from({ length: callsPerRecord }, (_, call) => ({
      id: `call-${sequence}-${call}`, category: 'tool', name: call < 9 ? 'Read' : 'Edit',
      status: 'success', order: call * 2, completedOrder: call * 2 + 1,
      file: { path: `/fixture/turn-${sequence}/file-${call % 9}.ts`, operation: call < 9 ? 'read' : 'edit' }
    }))
    const record = {
      schemaVersion: 1, recordKind: 'agent_turn', sequence,
      recordId: String(sequence).padStart(32, '0'), recorderVersion: 'fixture',
      workspace: { id: 'fixture', root: '/fixture' }, provider: { id: 'claude' },
      sessionId: 'fixture-session', generation: sequence, turnIndex: sequence,
      startedAt, completedAt, durationMs: 1000, status: 'completed',
      user: available({ text: 'fixture', textHash: sha256('fixture') }),
      assistant: available({ text: 'fixture', textHash: sha256('fixture') }),
      tools: available(tools), files: available(tools.map(call => call.file)),
      skills: available([]), mcps: available([]), hooks: available([]),
      usage: unavailable(), diff: available([]), dangerousOperations: available([]), errors: available([])
    }
    assert.equal(validateAgentTurnRecord(record).ok, true, 'fixture must satisfy the production schema')
    return record
  })
}

function counted(records, invocations) {
  const identities = new Set(records)
  const push = Array.prototype.push
  let entries = 0
  let recordReads = 0
  let result
  // Observe existing production-created entries, not an inferred N*T formula.
  // The count guard fails if construction changes to bypass this observation.
  Array.prototype.push = function (...items) {
    for (const item of items) {
      if (!item || typeof item !== 'object' || !identities.has(item.record) ||
          !item.call || typeof item.sourceIndex !== 'number') continue
      let record = item.record
      Object.defineProperty(item, 'record', {
        enumerable: true, configurable: true,
        get() { recordReads++; return record },
        set(value) { record = value }
      })
      entries++
    }
    return Reflect.apply(push, this, items)
  }
  try {
    for (let index = 0; index < invocations; index++) result = summarizeTurnRecords(records, 'fixture-session')
  } finally {
    Array.prototype.push = push
  }
  assert.equal(entries, records.length * callsPerRecord * invocations)
  return { result, entries, recordReads }
}

const results = []
const workloads = [1, 186].map(fixture)
for (const records of workloads) {
  const count = records.length
  const inputSha256 = sha256(JSON.stringify(records))
  const expected = summarizeTurnRecords(records, 'fixture-session')
  assert.equal(expected.turns, count)
  assert.equal(expected.calls.total, count * callsPerRecord)
  assert.equal(expected.files.uniquePaths, count * 9)
  assert.deepEqual(expected.files.writeCoverage, {
    written: count * 9, readBefore: count * 9, inferredReadBefore: 0, blind: []
  })
  assert(expected.files.rows.every(row => row.read === 1 && row.edit === 1 && row.write === 0 && row.inferredRead === 0))
  // Time every case before installing any getter, so instrumentation cannot pollute
  // V8's property-access feedback for later timing cases. Include all summary fields.
  for (let index = 0; index < 3; index++) summarizeTurnRecords(records, 'fixture-session')
  const samples = []
  for (let index = 0; index < 9; index++) {
    const start = performance.now()
    const result = summarizeTurnRecords(records, 'fixture-session')
    samples.push(performance.now() - start)
    assert.deepEqual(result, expected)
  }
  assert.equal(sha256(JSON.stringify(records)), inputSha256, 'summary must not mutate source records')
  const sorted = samples.toSorted((a, b) => a - b)
  results.push({ records: count, calls: count * callsPerRecord, inputSha256,
    summarySha256: sha256(JSON.stringify(expected)),
    samplesMs: samples, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] })
}
for (const [index, records] of workloads.entries()) {
  const expected = summarizeTurnRecords(records, 'fixture-session')
  const single = counted(records, 1)
  const duplicate = counted(records, 2)
  assert.deepEqual(single.result, expected, 'instrumentation must preserve the entire summary')
  assert.deepEqual(duplicate.result, expected)
  assert.equal(sha256(JSON.stringify(single.result)), results[index].summarySha256)
  assert.equal(sha256(JSON.stringify(records)), results[index].inputSha256)
  assert.equal(duplicate.recordReads, single.recordReads * 2, 'redundant summary work must remain observable')
  Object.assign(results[index], { recordReads: single.recordReads, observedEntries: single.entries,
    sensitivity: { duplicateRecordReads: duplicate.recordReads, passed: true } })
}
const report = {
  schema: 1, node: process.version, platform: process.platform,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  bundleSha256: sha256(await readFile(bundle)),
  workload: { records: [1, 186], callsPerRecord, distinctPathsPerRecord: 9, warmups: 3, samples: 9 },
  scope: 'production full session summary on schema-valid synthetic records; excludes CLI startup, file reading/parsing, Provider and upload; timings have no instrumentation',
  counter: 'OrderedCall.record property reads across all summary phases; not total CPU work or Map operations',
  results
}
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
