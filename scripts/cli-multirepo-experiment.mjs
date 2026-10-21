#!/usr/bin/env node
// Informational experiment, not a gate. Run under timing-run.mjs after build:cli.
// All limits receive the same 19 repositories and four turns (one changed file on turn 4).
// The limiter is experimental caller scheduling, NOT a production recorder change.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const output = process.argv[2]
assert(output, 'usage: node scripts/cli-multirepo-experiment.mjs <output.json>')
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = join(sourceRoot, 'packages/turn-recorder-cli/dist/core/turn-recorder/git.js')
const bundleSha256 = createHash('sha256').update(await readFile(bundle)).digest('hex')
const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-cli-multirepo-fixture-')))
const home = join(root, 'home')
await mkdir(home)
const savedEnv = { ...process.env }
// No user/global config, templates, hooks, injected Git location or optional fsmonitor.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
Object.assign(process.env, {
  HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0'
})

const original = new Map()
const custom = Symbol.for('nodejs.util.promisify.custom')
let active = false
let processes = 0
let gitProcesses = 0
let inFlight = 0
let peak = 0
let commands = new Map()

function begin(command, args, shell) {
  if (!active) return () => {}
  processes++
  const executable = shell ? String(command).trim().split(/\s+/)[0] : String(command)
  if (executable.split('/').at(-1) === 'git') {
    gitProcesses++
    const verb = Array.isArray(args)
      ? args.find(value => ['rev-parse', 'status', 'config', 'check-ignore', 'read-tree', 'update-index', 'add', 'write-tree', 'diff'].includes(value)) ?? 'other'
      : 'shell'
    commands.set(verb, (commands.get(verb) ?? 0) + 1)
  }
  inFlight++
  peak = Math.max(peak, inFlight)
  let ended = false
  return () => { if (!ended) { ended = true; inFlight-- } }
}

for (const name of ['execFile', 'execFileSync', 'exec', 'execSync', 'spawn', 'spawnSync', 'fork']) {
  const fn = childProcess[name]
  original.set(name, fn)
  const wrapped = (...args) => {
    const end = begin(args[0], args[1], name === 'exec' || name === 'execSync')
    try {
      const result = Reflect.apply(fn, childProcess, args)
      if (name.endsWith('Sync')) end()
      else { result.once('error', end); result.once('close', end) }
      return result
    } catch (error) { end(); throw error }
  }
  if (typeof fn[custom] === 'function') {
    Object.defineProperty(wrapped, custom, { value: (...args) => {
      const end = begin(args[0], args[1], name === 'exec')
      try { return Reflect.apply(fn[custom], childProcess, args).finally(end) }
      catch (error) { end(); throw error }
    } })
  }
  childProcess[name] = wrapped
}
syncBuiltinESMExports()
const { beginGitTurnDiff, finishGitTurnDiff, cancelGitTurnDiff } = await import(pathToFileURL(bundle).href)

function resetCounters() {
  assert.equal(inFlight, 0, 'measurement must not cross a live subprocess boundary')
  processes = 0
  gitProcesses = 0
  peak = 0
  commands = new Map()
}
function counters() {
  return { processes, gitProcesses, peakProcesses: peak, commands: Object.fromEntries(commands) }
}
async function measure(operation) {
  resetCounters()
  active = true
  const started = performance.now()
  try {
    const value = await operation()
    return { value, elapsedMs: performance.now() - started, ...counters() }
  } finally { active = false }
}
async function scheduled(items, limit, operation) {
  if (limit === items.length) return Promise.all(items.map(operation))
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await operation(items[index], index)
    }
  }))
  return results
}
function git(repo, args) {
  childProcess.execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd: repo, stdio: 'pipe' })
}
function countBy(values, key) {
  const counts = {}
  for (const value of values) { const name = key(value); counts[name] = (counts[name] ?? 0) + 1 }
  return counts
}
function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }
}
const results = []
const report = {
  schema: 1, node: process.version, platform: process.platform, sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(),
  bundleSha256, workload: { repositories: 19, trackedFilesPerRepo: 512, turnsPerLimit: 4, changedRepoTurns: [4], changedFiles: 1, limits: [19, 4, 1], warmupTurnsPerLimit: 1 },
  scope: 'production begin/finish functions with experimental caller scheduling; excludes discovery, transcript, recorder locks and notifications; no Provider',
  results
}
try {
  // Sensitivity control: a real extra Git process must be counted, not merely inferred.
  const control = await measure(async () => { git(root, ['--version']) })
  assert.equal(control.gitProcesses, 1)
  assert.equal(control.processes, 1)
  assert.equal(control.peakProcesses, 1)
  report.sensitivity = { injectedGitProcesses: control.gitProcesses, passed: true }
  const repos = []
  for (let index = 0; index < report.workload.repositories; index++) {
    const repo = join(root, `repo-${index}`)
    await mkdir(repo)
    git(repo, ['-c', 'init.templateDir=', 'init', '-q'])
    for (let group = 0; group < 16; group++) {
      const dir = join(repo, `dir-${group}`)
      await mkdir(dir)
      await Promise.all(Array.from({ length: 32 }, (_, file) =>
        writeFile(join(dir, `file-${file}.txt`), `baseline ${group} ${file}\n`)))
    }
    git(repo, ['add', '.'])
    git(repo, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@scry.invalid', 'commit', '-qm', 'baseline'])
    repos.push(repo)
  }
  const target = join(repos[0], 'dir-0/file-0.txt')
  // One warm-up and four measured turns per limit. Rotate order to reduce systematic cache bias.
  for (let turn = 0; turn <= 4; turn++) {
    const limits = [[19, 4, 1], [4, 1, 19], [1, 19, 4]][turn % 3]
    for (const limit of limits) {
      await writeFile(target, 'baseline 0 0\n')
      let captures = []
      try {
        const start = await measure(async () => scheduled(repos, limit, repo => beginGitTurnDiff(repo)))
        captures = start.value
        const changed = turn === 4
        if (changed) await writeFile(target, 'changed during turn\n')
        const finish = await measure(async () => scheduled(captures, limit, capture =>
          finishGitTurnDiff(capture, undefined, { structuredPaths: [], completePatches: true })))
        const snapshots = finish.value
        const correct = snapshots.every((snapshot, index) => {
          if (snapshot.status !== 'captured') return false
          if (!changed || index !== 0) return snapshot.files.length === 0
          return snapshot.files.length === 1 && snapshot.files[0].path === target &&
            snapshot.files[0].patch?.includes('+changed during turn')
        })
        if (turn > 0) results.push({
          limit, turn, changed, evidenceCorrect: correct,
          begin: { ...start, value: undefined, statuses: countBy(captures, capture => capture.status) },
          finish: { ...finish, value: undefined, statuses: countBy(snapshots, snapshot => snapshot.status),
            strategies: countBy(snapshots, snapshot => snapshot.collection?.strategy ?? 'unavailable'),
            fallbacks: countBy(snapshots.filter(snapshot => snapshot.collection?.fallbackReason), snapshot => snapshot.collection.fallbackReason) }
        })
        if (!correct && turn === 0) report.warmupEvidenceFailures = (report.warmupEvidenceFailures ?? 0) + 1
      } finally { await Promise.all(captures.map(capture => cancelGitTurnDiff(capture))) }
    }
  }
  report.summary = report.workload.limits.map(limit => {
    const rows = results.filter(row => row.limit === limit)
    return {
      limit, samples: rows.length, evidenceCorrect: rows.every(row => row.evidenceCorrect),
      beginMs: quantiles(rows.map(row => row.begin.elapsedMs)), finishMs: quantiles(rows.map(row => row.finish.elapsedMs)),
      totalCaptureMs: quantiles(rows.map(row => row.begin.elapsedMs + row.finish.elapsedMs)),
      gitProcesses: rows.map(row => row.begin.gitProcesses + row.finish.gitProcesses),
      peakProcesses: Math.max(...rows.flatMap(row => [row.begin.peakProcesses, row.finish.peakProcesses]))
    }
  })
  process.stdout.write(`${JSON.stringify({ sensitivity: report.sensitivity, summary: report.summary }, null, 2)}\n`)
  if (results.some(row => !row.evidenceCorrect) || report.warmupEvidenceFailures) process.exitCode = 1
} finally {
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rm(root, { recursive: true, force: true })
  for (const [name, fn] of original) childProcess[name] = fn
  syncBuiltinESMExports()
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
}
