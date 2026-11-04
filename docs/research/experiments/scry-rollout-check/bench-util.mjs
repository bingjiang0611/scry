import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { now, sleep } from './bench-args.mjs'
import { nestedRepositories } from './bench-copy.mjs'

// ---------- stats ----------
function stats(values, unit = 'ms') {
  if (!values.length) return { status: 'unavailable', reason: 'no samples' }
  const s = [...values].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]
  const round = (v) => Math.round(v * 10) / 10
  // Raw samples (in measurement order) let perf-ab test a difference instead of comparing two p50s.
  return { status: 'measured', unit, n: s.length, p50: round(q(0.5)), p95: round(q(0.95)), min: round(s[0]), max: round(s.at(-1)),
    ...(values.length <= 500 ? { samples: values.map(round) } : {}) }
}
const unavailable = (reason) => ({ status: 'unavailable', reason })
const load = () => loadavg().map((v) => Math.round(v * 100) / 100)

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
}
const tryRun = (cmd, args, options) => { try { return run(cmd, args, options) } catch { return undefined } }
const node = (cli, args, options = {}) => run(process.execPath, [cli, ...args], options)

function environment() {
  return {
    at: new Date().toISOString(), platform: platform(), release: release(), arch: arch(),
    cpu: cpus()[0]?.model, cpuCount: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30),
    macos: tryRun('sw_vers', ['-productVersion']), node: process.version, git: tryRun('git', ['--version']),
    loadAverage: load()
  }
}

function repoStats(work) {
  const tracked = run('git', ['-C', work, 'ls-files', '-z']).split('\0').filter(Boolean).length
  const untracked = run('git', ['-C', work, 'ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean).length
  const ignored = run('git', ['-C', work, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']).split('\0').filter(Boolean).length
  const commits = Number(tryRun('git', ['-C', work, 'rev-list', '--count', 'HEAD']) ?? 0)
  const gitDirKiB = Number(tryRun('du', ['-sk', join(work, '.git')])?.split(/\s+/)[0] ?? NaN)
  const submodules = (tryRun('git', ['-C', work, 'submodule', 'status']) ?? '').split('\n').filter(Boolean).length
  // Nested repositories cloned into the tree (e.g. by a setup script) are part of the workload:
  // the recorder snapshots each of them, so their number changes every turn's git cost.
  const nestedRepos = nestedRepositories(work).length
  const timings = []
  for (let i = 0; i < 5; i++) { const t = now(); run('git', ['-C', work, 'status', '--porcelain=v2', '-uall']); timings.push(now() - t) }
  return { tracked, untracked, ignoredEntries: ignored, commits, gitDirMiB: Math.round(gitDirKiB / 1024), submodules, nestedRepos, gitStatus: stats(timings) }
}

const lineCount = (file) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
async function settledCount(file) {
  // Background work (deferred delivery, recovery) may still call git right after a hook returns.
  let last = -1
  for (let i = 0; i < 20; i++) { const c = lineCount(file); if (c === last) return c; last = c; await sleep(100) }
  return last
}

// ---------- recorder hook path ----------
function hook(work, provider, event, payload, env = {}, exactEnv) {
  const t = now()
  const r = spawnSync('/bin/sh', [join(work, '.scry/provider-hook.sh'), provider, event], {
    input: JSON.stringify(payload), env: { ...(exactEnv ?? process.env), SCRY_RECORDER_MANAGED: '0', ...env }, stdio: ['pipe', 'ignore', 'pipe']
  })
  const ms = now() - t
  if (r.status !== 0) throw new Error(`hook ${provider} ${event} exited ${r.status}: ${String(r.stderr).slice(0, 300)}`)
  return ms
}
const recordCount = (work) => existsSync(join(work, '.scry/records')) ? readdirSync(join(work, '.scry/records')).filter((n) => n.endsWith('.json')).length : 0
const skipCount = (work) => existsSync(join(work, '.scry/logs/hook-skip.log')) ? readFileSync(join(work, '.scry/logs/hook-skip.log'), 'utf8').split('\n').filter(Boolean).length : 0

async function turn(work, provider, tools, env, dirty, exactEnv) {
  const session = `perf-${provider}-${randomBytes(4).toString('hex')}`
  let clock = Date.now()
  const ts = () => new Date(++clock).toISOString()
  const base = { session_id: session, cwd: work }
  const times = { start: 0, tool: [], stop: 0, visibleMs: undefined }
  const before = recordCount(work)
  times.start = hook(work, provider, 'UserPromptSubmit', { ...base, prompt: `[perf-bench] ${session}`, timestamp: ts() }, env, exactEnv)
  if (dirty) dirty.apply()
  for (let i = 0; i < tools; i++) {
    const id = `call-${i}`
    times.tool.push(hook(work, provider, 'PreToolUse', { ...base, tool_name: 'Bash', tool_use_id: id, tool_input: { command: `echo ${i}` }, timestamp: ts() }, env, exactEnv))
    times.tool.push(hook(work, provider, 'PostToolUse', { ...base, tool_name: 'Bash', tool_use_id: id, tool_response: `out ${i}\n`.repeat(20), timestamp: ts() }, env, exactEnv))
  }
  const stopAt = now()
  times.stop = hook(work, provider, 'Stop', { ...base, assistant_response: 'done', timestamp: ts() }, env, exactEnv)
  // A record that is accepted but committed later still makes the user wait for evidence; measure it.
  for (const deadline = now() + 30_000; now() < deadline; await sleep(20)) {
    if (recordCount(work) > before) { times.visibleMs = now() - stopAt; break }
  }
  if (dirty) dirty.restore()
  return times
}

// Files the recorder or the Providers read: never touched by the dirty scenario.

export { stats, unavailable, load, run, tryRun, node, environment, repoStats, lineCount, settledCount, hook, recordCount, skipCount, turn }
