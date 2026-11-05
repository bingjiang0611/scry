#!/usr/bin/env node
/**
 * Measure the wall time of one multi-repository turn start and turn end under different
 * repository concurrency limits. Informational: no thresholds.
 *
 * The recorder currently starts every repository's capture with `Promise.all`. This probe answers
 * whether a bounded pool would actually be faster on this machine, which L1 process counts cannot
 * answer. Run it under the timing lock:
 *
 *   node .agents/skills/scry-performance-climb/scripts/timing-run.mjs repo-concurrency -- \
 *     node scripts/recorder-repo-concurrency.measure.mjs --repos=18 --samples=12
 */
import { rm, writeFile } from 'node:fs/promises'
import { cpus, loadavg, platform, release } from 'node:os'
import { join } from 'node:path'
import {
  cleanupTemp, loadDist, makeTempRoot, newRepo, resetRepo, workspaceRoot
} from './recorder-engine-bench-fixtures.mjs'

const argValue = (name, fallback) => {
  const found = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))
  return found === undefined ? fallback : Number(found.replace(`--${name}=`, ''))
}
const repositories = argValue('repos', 18)
const samples = argValue('samples', 12)
const limits = [1, 2, 4, 8, Number.POSITIVE_INFINITY]

const { beginGitTurnDiff, finishGitTurnDiff } = await loadDist('git')
const tempRoot = makeTempRoot()

async function pool(items, limit, fn) {
  if (!Number.isFinite(limit)) return Promise.all(items.map((item, index) => fn(item, index)))
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]
}

const root = await workspaceRoot(tempRoot, 'repo-concurrency')
for (let index = 0; index < repositories; index++) await newRepo(join(root, `repo-${index}`), { files: 20 })
const repos = Array.from({ length: repositories }, (_, index) => join(root, `repo-${index}`))

async function mutate(round) {
  for (const index of [0, 7, 13]) {
    await writeFile(join(repos[index], 'src', 'f0.ts'), `export const changed = ${round}\n`)
  }
}

async function measure(limit, round) {
  await Promise.all(repos.map((repo) => resetRepo(repo)))
  const startedAt = process.hrtime.bigint()
  // The baseline is taken before the mutation, exactly as a real turn start does; mutating first
  // would fold the change into the baseline and measure the no-change finish path.
  const captures = await pool(repos, limit, (repo) => beginGitTurnDiff(repo, 5_000, join(root, 'captures'), []))
  const beginMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  await mutate(round)
  const finishStartedAt = process.hrtime.bigint()
  const snapshots = await pool(captures, limit, (capture) => finishGitTurnDiff(capture, 20_000, {}))
  const endMs = Number(process.hrtime.bigint() - finishStartedAt) / 1e6
  const statuses = captures.map((capture) => capture.status)
  const changed = snapshots.filter((snapshot) => snapshot.files.length > 0).length
  return { beginMs, endMs, statuses, changed }
}

const results = new Map(limits.map((limit) => [limit, []]))
for (let round = 0; round <= samples; round++) {
  // Alternate order so filesystem cache and thermal drift do not always favour one limit.
  const order = round % 2 === 0 ? limits : [...limits].reverse()
  for (const limit of order) {
    const measured = await measure(limit, round)
    if (round > 0) results.get(limit).push(measured)
  }
}

const environment = {
  platform: platform(), release: release(), cpu: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length,
  loadavg: loadavg().map((value) => Number(value.toFixed(2))), repositories, samples
}
const report = {
  schema: 1,
  scope: 'one turn start + one turn end across 18 repositories, 3 with changes',
  environment,
  limits: limits.map((limit) => {
    const rows = results.get(limit)
    const begin = rows.map((row) => row.beginMs)
    const end = rows.map((row) => row.endMs)
    return {
      limit: Number.isFinite(limit) ? limit : 'unbounded',
      beginP50: round(percentile(begin, 0.5)),
      beginP90: round(percentile(begin, 0.9)),
      endP50: round(percentile(end, 0.5)),
      endP90: round(percentile(end, 0.9)),
      changedDetected: rows.map((row) => row.changed),
      failedCaptures: rows.flatMap((row) => row.statuses.filter((status) => status !== 'ready'))
    }
  })
}
function round(value) { return Math.round(value * 10) / 10 }

process.stdout.write(`repo concurrency probe: ${repositories} repositories, ${samples} samples\n`)
for (const row of report.limits) {
  process.stdout.write(
    `  limit=${String(row.limit).padStart(9)} start p50=${String(row.beginP50).padStart(7)}ms p90=${String(row.beginP90).padStart(7)}ms` +
    `  end p50=${String(row.endP50).padStart(7)}ms p90=${String(row.endP90).padStart(7)}ms` +
    `  changed=${row.changedDetected.join(',')} failed=${row.failedCaptures.length}\n`
  )
}
process.stdout.write(`SCRY_REPO_CONCURRENCY=${JSON.stringify(report)}\n`)

await rm(root, { recursive: true, force: true })
cleanupTemp(tempRoot)
