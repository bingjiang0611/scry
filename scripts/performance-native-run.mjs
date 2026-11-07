#!/usr/bin/env node
// Measurement orchestration for the native App gate: run one lane or one per-scenario shard,
// combine shards measured in the same job, and write the retained report. Report schema,
// validation and comparison stay in performance-native.mjs so both sides freeze one harness.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { compareNative, exportNativeCounters, formatNative, nativeHarnessFiles, nativeWorkloads, validateNative } from './performance-native.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

async function bench(output, scenarios = Object.keys(nativeWorkloads)) {
  mkdirSync(dirname(resolve(output)), { recursive: true })
  const report = nativeReportHeader()
  for (const scenario of scenarios) {
    const run = spawnSync(process.execPath, ['scripts/session-open-bench.mjs', scenario], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    writeFileSync(`${output}.${scenario}.log`, `${run.stdout ?? ''}\n${run.stderr ?? ''}`)
    try {
      assert.equal(run.status, 0, `native ${scenario} failed (${run.error?.message ?? run.signal ?? run.status}); see retained log`)
      report.results[scenario] = JSON.parse(run.stdout)
    } catch (error) { report.errors.push({ scenario, message: error.message }) }
    report.counters = exportNativeCounters(report)
    writeFileSync(output, JSON.stringify(report, null, 2))
  }
  // A single-scenario shard is validated after `combine`; complete runs validate here.
  if (scenarios.length === Object.keys(nativeWorkloads).length) validateNative(report)
  publishNativeReport(output, report)
}

function nativeReportHeader() {
  const hash = createHash('sha256')
  for (const file of nativeHarnessFiles) hash.update(file).update(readFileSync(join(root, file)))
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  assert.equal(revision.status, 0)
  return { schema: 1, revision: revision.stdout.trim(), harness: hash.digest('hex'), environment: { platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, node: process.version }, results: {}, errors: [] }
}

function publishNativeReport(output, report) {
  report.counters = exportNativeCounters(report)
  writeFileSync(output, JSON.stringify(report, null, 2))
  const counterOutput = output.endsWith('.json') ? `${output.slice(0, -'.json'.length)}.counters.json` : `${output}.counters.json`
  writeFileSync(counterOutput, `${JSON.stringify(report.counters, null, 2)}\n`)
}

/** Combine per-scenario shards measured in the same job. Interleaving each scenario's two
 * sources keeps a slow machine window from landing entirely on one side, while every
 * threshold, metric and fixed workload stays exactly as before. */
export function combineNativeShards(shards) {
  assert.ok(shards.length > 0, 'no native shards to combine')
  const [first] = shards
  assert.equal(first.schema, 1, 'shard schema')
  const report = { schema: 1, revision: first.revision, harness: first.harness, environment: first.environment, results: {}, errors: [] }
  for (const shard of shards) {
    assert.equal(shard.schema, 1, 'shard schema')
    assert.equal(shard.revision, report.revision, 'shard revision differs')
    assert.equal(shard.harness, report.harness, 'shard harness differs')
    assert.deepEqual(shard.environment, report.environment, 'shard environment differs')
    for (const [scenario, result] of Object.entries(shard.results)) {
      assert.equal(report.results[scenario], undefined, `duplicate ${scenario} shard`)
      report.results[scenario] = result
    }
    report.errors.push(...shard.errors)
  }
  // Revision, harness and environment can match while the built App differs: each scenario result
  // carries the digest of the artifact it measured. Mixing builds would compare two products, so
  // every merged scenario must share one build and one runtime identity.
  const identities = new Set(Object.values(report.results).map(result => JSON.stringify([result.platform, result.node, result.electron, result.artifactSha256])))
  assert.equal(identities.size, 1, 'shards were measured on different builds or runtimes')
  validateNative(report)
  return report
}

function combine(output, shardPaths) {
  const header = nativeReportHeader()
  const report = combineNativeShards(shardPaths.map(shardPath => JSON.parse(readFileSync(shardPath, 'utf8'))))
  assert.equal(report.revision, header.revision, 'shards belong to another revision')
  assert.equal(report.harness, header.harness, 'shards used another harness')
  assert.deepEqual(report.environment, header.environment, 'shards came from another environment')
  publishNativeReport(output, report)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'bench' && (args.length === 1 || (args.length === 2 && Object.hasOwn(nativeWorkloads, args[1])))) await bench(args[0], args[1] ? [args[1]] : undefined)
    else if (command === 'combine' && args.length >= 2) combine(args[0], args.slice(1))
    else if (command === 'compare' && args.length === 3) {
      const [base, head, output] = args
      const report = compareNative(JSON.parse(readFileSync(base, 'utf8')), JSON.parse(readFileSync(head, 'utf8')))
      const markdown = formatNative(report)
      writeFileSync(output, markdown)
      writeFileSync(`${output}.json`, JSON.stringify(report, null, 2))
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
      if (!report.passed) process.exitCode = 1
    } else throw new Error('Usage: performance-native-run.mjs bench <output.json> [scenario] | combine <output.json> <shard.json>... | compare <baseline.json> <candidate.json> <report.md>')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
