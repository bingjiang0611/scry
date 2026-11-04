#!/usr/bin/env node
// Performance baseline for the Scry recorder (hook path) and the uploader.
//
// It never touches the source repository: it works on a copy (APFS clone when
// available), strips any uploader commit hook from the copy's config, points the
// copy's origin at an invalid host, and drives synthetic hook events through the
// copy's own `.scry/provider-hook.sh` — the same entry a Provider calls. The
// uploader part runs in temporary HOME/XDG directories against the fake transport
// in this folder, so nothing is uploaded.
//
//   node perf-bench.mjs --source <repo> --work <copy dir> --scry <scry cli> \
//     --uploader <uploader dist/cli.js> [--rounds 7] [--out <dir>] [--only recorder|uploader|hookwrap]
//     [--skip-hookwrap] [--uploader-scry <scry cli for the uploader instead of its bundled one>]
//     [--workload-name <alias written instead of the source repo name>] [--provider qoder]
//     [--phases recorder,hookwrap] [--label <build under test>] [--protocol <protocol.json outside the repo>]
//   node perf-bench.mjs e2e --work <copy dir> --cmd '<provider command with {prompt}>' --runs 5
//
// Milliseconds are wall time on this machine under its current load; the report
// records load average per phase. Run nothing else heavy at the same time and do
// not run two copies of this script at once (it takes a lock).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const sub = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'baseline'
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
const ROUNDS = Number(opt('rounds', 7))
// Real protocol names can live outside the checkout (--protocol or SCRY_PERF_PROTOCOL), so they can
// never be committed by accident. Default: protocol.json next to this script (public aliases).
const PROTOCOL_PATH = resolve(opt('protocol', process.env.SCRY_PERF_PROTOCOL || join(here, 'protocol.json')))
const outDir = resolve(opt('out', join(process.cwd(), 'perf-baseline')))
mkdirSync(outDir, { recursive: true })

// ---------- lock: one timing run at a time ----------
const lockPath = join(tmpdir(), 'scry-perf-bench.lock')
if (existsSync(lockPath)) {
  const pid = Number(readFileSync(lockPath, 'utf8'))
  let alive = false
  try { process.kill(pid, 0); alive = true } catch {}
  if (alive) { console.error(`another perf-bench run holds ${lockPath} (pid ${pid})`); process.exit(2) }
}
writeFileSync(lockPath, String(process.pid))
process.on('exit', () => { try { rmSync(lockPath) } catch {} })

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

// ---------- copy of the source repository ----------
const MARKER = join('.git', 'scry-perf-bench-copy')
function prepareCopy(source, work) {
  source = realpathSync(source)
  if (!existsSync(join(source, '.git'))) throw new Error(`${source} is not a Git checkout root`)
  if (statSync(join(source, '.git')).isFile()) throw new Error(`${source} is a linked worktree; its copy would share the original index. Use the main checkout or a fresh clone.`)
  const target = resolve(work)
  if (target === source || target.startsWith(source + '/')) throw new Error('--work must be outside --source')
  if (existsSync(target)) {
    if (!existsSync(join(target, MARKER))) throw new Error(`${target} exists and was not created by perf-bench; pick an empty path`)
  } else {
    mkdirSync(target, { recursive: true })
    const started = now()
    // Clone entry by entry so the source's `.scry` (records, sockets) is never copied. APFS clone
    // (copy-on-write) on macOS, reflink where supported elsewhere; a silent full copy of a large
    // tree is refused unless asked for.
    for (const entry of readdirSync(source)) {
      if (entry === '.scry') continue
      const args = platform() === 'darwin' ? ['-cR', join(source, entry), target] : ['-a', '--reflink=auto', join(source, entry), target]
      const attempt = spawnSync('cp', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      if (attempt.status !== 0) {
        if (!argv.includes('--allow-full-copy')) throw new Error(`clone of ${entry} failed (${String(attempt.stderr).trim().slice(0, 200)}); rerun with --allow-full-copy to copy it fully`)
        cpSync(join(source, entry), join(target, entry), { recursive: true })
      }
    }
    writeFileSync(join(target, MARKER), JSON.stringify({ source, copiedAt: new Date().toISOString(), copyMs: Math.round(now() - started) }))
  }
  // A nested repository whose `.git` is a file (linked worktree, absorbed submodule) points at a git
  // directory. If that directory is outside the copy, git commands in the copy (the dirty scenario
  // edits and restores files) would write the source's index. Refuse instead.
  const outside = []
  for (const repo of nestedRepositories(target)) {
    const dotgit = join(repo, '.git')
    if (!statSync(dotgit).isFile()) continue
    const line = readFileSync(dotgit, 'utf8').split('\n').find((l) => l.startsWith('gitdir:'))
    const gitdir = line && resolve(repo, line.slice('gitdir:'.length).trim())
    if (!gitdir || gitdir !== target && !gitdir.startsWith(target + '/')) outside.push(`${relative(target, repo)} -> ${gitdir ?? 'unreadable'}`)
  }
  if (outside.length) throw new Error(`nested repositories in the copy point at git directories outside it (worktrees or external git dirs); git in the copy would change the source:\n  ${outside.join('\n  ')}\nUse a source whose nested repositories are plain clones or submodules with relative git dirs.`)
  // The copy must not inherit the source's recorder data or upload configuration.
  rmSync(join(target, '.scry'), { recursive: true, force: true })
  const config = join(target, 'scry.config.json')
  if (existsSync(config)) {
    const value = JSON.parse(readFileSync(config, 'utf8'))
    delete value.commitHook
    delete value.dataDir
    writeFileSync(config, JSON.stringify(value, null, 2) + '\n')
  }
  if (tryRun('git', ['-C', target, 'remote', 'get-url', 'origin']) !== undefined)
    run('git', ['-C', target, 'remote', 'set-url', 'origin', `git@perf-bench.invalid:scry-perf-bench/${basename(source)}.git`])
  return target
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

// ---------- L1: git subprocesses per hook event ----------
// A `git` shim placed first on PATH logs each call, then execs the real git. It runs in a separate,
// untimed pass (the shim itself costs a fork), with the recorder daemon restarted under the shim so
// the daemon's git calls are counted too. Counts are exact and machine independent: a lower count
// is L1 evidence, a higher one is a regression no matter what the milliseconds say.
let gitShim
function gitShimDir() {
  if (gitShim) return gitShim
  const real = tryRun('/bin/sh', ['-c', 'command -v git'])
  if (!real) return undefined
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scry-perf-gitshim-')))
  // Logs the git subcommand (first argument that is not a global option) for the breakdown.
  const shim = [
    '#!/bin/sh',
    'if [ -n "$SCRY_PERF_GIT_LOG" ]; then',
    '  sub=; skip=',
    '  for a in "$@"; do',
    '    if [ -n "$skip" ]; then skip=; continue; fi',
    '    case "$a" in -C|-c|--git-dir|--work-tree|--namespace|--exec-path) skip=1 ;; -*) ;; *) sub=$a; break ;; esac',
    '  done',
    `  printf '%s\\n' "\${sub:-?}" >> "$SCRY_PERF_GIT_LOG"`,
    'fi',
    `exec ${JSON.stringify(real)} "$@"`, '']
  writeFileSync(join(dir, 'git'), shim.join('\n'), { mode: 0o755 })
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  gitShim = dir
  return dir
}
const lineCount = (file) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
async function settledCount(file) {
  // Background work (deferred delivery, recovery) may still call git right after a hook returns.
  let last = -1
  for (let i = 0; i < 20; i++) { const c = lineCount(file); if (c === last) return c; last = c; await sleep(100) }
  return last
}

async function countGitCalls(work, provider, tools, env, dirty, exactEnv, stop) {
  const dir = gitShimDir()
  if (!dir) return unavailable('git not found on PATH')
  const log = join(dir, `calls-${randomBytes(4).toString('hex')}.log`)
  const basePath = (exactEnv ?? process.env).PATH ?? ''
  // No background upload workers during the count: only work done on the hook path (including the
  // launchers the hook waits for) is counted, so the numbers do not depend on worker timing.
  const counted = { ...env, PATH: `${dir}:${basePath}`, SCRY_PERF_GIT_LOG: log, SCRY_UPLOADER_NO_SPAWN: '1' }
  stop()   // the next hook starts a daemon that inherits the shim
  await turn(work, provider, 1, counted, undefined, exactEnv)   // warm-up under the shim, not counted
  await settledCount(log)
  const session = `perf-count-${randomBytes(4).toString('hex')}`
  let clock = Date.now()
  const ts = () => new Date(++clock).toISOString()
  const base = { session_id: session, cwd: work }
  const delta = async (fn) => { const before = await settledCount(log); fn(); return (await settledCount(log)) - before }
  const out = { turnStart: 0, toolEvents: 0, stop: 0 }
  out.turnStart = await delta(() => hook(work, provider, 'UserPromptSubmit', { ...base, prompt: `[perf-bench] ${session}`, timestamp: ts() }, counted, exactEnv))
  if (dirty) dirty.apply()
  for (let i = 0; i < tools; i++) {
    const id = `call-${i}`
    out.toolEvents += await delta(() => hook(work, provider, 'PreToolUse', { ...base, tool_name: 'Bash', tool_use_id: id, tool_input: { command: `echo ${i}` }, timestamp: ts() }, counted, exactEnv))
    out.toolEvents += await delta(() => hook(work, provider, 'PostToolUse', { ...base, tool_name: 'Bash', tool_use_id: id, tool_response: `out ${i}\n`.repeat(20), timestamp: ts() }, counted, exactEnv))
  }
  out.stop = await delta(() => hook(work, provider, 'Stop', { ...base, assistant_response: 'done', timestamp: ts() }, counted, exactEnv))
  if (dirty) dirty.restore()
  stop()   // later timed turns must not run under the shim
  const subcommands = {}
  for (const l of readFileSync(log, 'utf8').split('\n').filter(Boolean)) subcommands[l] = (subcommands[l] ?? 0) + 1
  return { status: 'measured', unit: 'count', ...out, total: out.turnStart + out.toolEvents + out.stop, note: 'one counted turn after a counted warm-up; includes git run by the daemon and by uploader launchers', subcommandsInclWarmup: subcommands }
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
const DIRTY_EXCLUDE = /^(scry\.config\.json|\.scry\/|\.qoder\/|\.codex\/|\.opencode\/|\.claude\/)/
function trackedSmall(repo, limit) {
  return run('git', ['-C', repo, 'ls-files', '-z']).split('\0')
    .filter((f) => f && !DIRTY_EXCLUDE.test(f) && /\.(ts|tsx|js|mjs|md|json|py|go|rs|java|kt|swift|c|cc|cpp|h|txt)$/.test(f))
    .filter((f) => { try { return statSync(join(repo, f)).size < 200_000 } catch { return false } }).slice(0, limit)
}
function nestedRepositories(work) {
  return (tryRun('find', [work, '-mindepth', '2', '-maxdepth', '5', '-name', '.git', '-not', '-path', '*/node_modules/*', '-not', '-path', `${work}/.git/*`]) ?? '')
    .split('\n').filter(Boolean).map((g) => dirname(g)).sort()
}

// Root: up to 20 tracked files modified + 50 new files. Nested repositories (if any): one tracked
// file modified in each of the first 3, so their diffs are part of the measured and checked work.
function dirtyTree(work) {
  const files = trackedSmall(work, 20)
  const nested = nestedRepositories(work).slice(0, 3).map((repo) => ({ repo, files: trackedSmall(repo, 1) })).filter((n) => n.files.length)
  const scratch = join(work, 'scry-perf-bench-scratch')
  return {
    modified: files.length,
    nested: nested.length,
    label: `dirty (${files.length} modified + 50 new files${nested.length ? ` + ${nested.length} nested repos` : ''})`,
    apply() {
      for (const f of files) appendFileSync(join(work, f), '\n// scry perf bench\n')
      for (const n of nested) for (const f of n.files) appendFileSync(join(n.repo, f), '\n// scry perf bench\n')
      mkdirSync(scratch, { recursive: true })
      for (let i = 0; i < 50; i++) writeFileSync(join(scratch, `f${i}.txt`), `bench ${i}\n`.repeat(50))
    },
    restore() {
      if (files.length) run('git', ['-C', work, 'checkout', '--', ...files])
      for (const n of nested) run('git', ['-C', n.repo, 'checkout', '--', ...n.files])
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

// Evidence check: the dirty turn's record, normalised (copy root replaced, timestamps, ids and
// durations dropped, keys sorted), hashed. A candidate must produce the same digest as the base:
// a speed-up that changes what the record says is not a speed-up.
const VOLATILE_KEY = /(At|Ms|Time|time|timestamp|duration|recordId|sessionId|session_id|sequence|generation|turnIndex|recorderVersion|pid)$/
function normalise(value, root) {
  if (Array.isArray(value)) return value.map((v) => normalise(v, root))
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) if (!VOLATILE_KEY.test(k)) out[k] = normalise(value[k], root)
    return out
  }
  return typeof value === 'string' ? value.split(root).join('<root>') : value
}
async function evidenceDigest(work, provider, dirty, env = {}) {
  const dir = join(work, '.scry', 'records')
  const before = new Set(existsSync(dir) ? readdirSync(dir) : [])
  await turn(work, provider, 2, env, dirty)
  const added = (existsSync(dir) ? readdirSync(dir) : []).filter((n) => n.endsWith('.json') && !before.has(n)).sort()
  if (added.length !== 1) return unavailable(`expected 1 new record, found ${added.length}`)
  const record = JSON.parse(readFileSync(join(dir, added[0]), 'utf8'))
  const sections = normalise({ status: record.status, diff: record.diff, files: record.files, tools: record.tools?.status }, work)
  if (Array.isArray(sections.diff?.value)) for (const snap of sections.diff.value) if (Array.isArray(snap.files)) snap.files.sort((a, b) => String(a.path).localeCompare(String(b.path)))
  const text = JSON.stringify(sections)
  return { status: 'measured', digest: createHash('sha256').update(text).digest('hex'),
    diffFiles: Array.isArray(record.diff?.value) ? record.diff.value.reduce((n, s) => n + (s.files?.length ?? 0), 0) : null,
    diffStatus: record.diff?.status, bytes: text.length }
}

function processUsage(pid) {
  const out = tryRun('ps', ['-o', 'rss=,time=', '-p', String(pid)])
  if (!out) return undefined
  const [rss, time] = out.trim().split(/\s+/)
  const [days, clock] = time.includes('-') ? time.split('-') : ['0', time]
  const seconds = Number(days) * 86400 + clock.split(':').map(Number).reduce((acc, v) => acc * 60 + v, 0)
  return { rssMiB: Math.round(Number(rss) / 1024), cpuSeconds: seconds }
}

async function recorderPhase(scry, work, report) {
  const provider = opt('provider', 'qoder')
  node(scry, ['init', '--workspace', work, '--providers', provider, '--json'])
  if (existsSync(join(work, 'scry.config.json'))) {
    const config = JSON.parse(readFileSync(join(work, 'scry.config.json'), 'utf8'))
    if (config.commitHook) throw new Error('copy still has a commitHook after init; refusing to run (it could upload)')
  }
  const r = { provider, note: 'synthetic hook payloads through the copy\'s provider-hook.sh; measures recorder work, not the Provider', modes: {} }
  // Warm-up turn: starts the daemon and fills OS caches; not counted.
  await turn(work, provider, 1, {}, undefined)
  const daemon = () => { try { return JSON.parse(node(scry, ['recorder', 'status', '--workspace', work])) } catch { return {} } }
  const startStatus = daemon()
  const startUsage = startStatus.pid ? processUsage(startStatus.pid) : undefined
  const dirty = dirtyTree(work)
  const scenarios = [
    ['clean, 0 tools', 0, undefined], ['clean, 5 tools', 5, undefined], ['clean, 30 tools', 30, undefined],
    [`${dirty.label}, 5 tools`, 5, dirty]
  ]
  for (const [mode, env] of [['daemon fast path', {}], ['CLI fallback', { SCRY_RECORDER_TRANSPORT: 'direct' }]]) {
    const out = {}
    for (const [name, tools, d] of scenarios) {
      const loadBefore = load()
      const samples = []
      for (let i = 0; i < ROUNDS; i++) samples.push(await turn(work, provider, tools, env, d))
      const totals = samples.map((s) => s.start + s.tool.reduce((a, b) => a + b, 0) + s.stop)
      const visible = samples.map((s) => s.visibleMs).filter((v) => v !== undefined)
      out[name] = {
        turnStart: stats(samples.map((s) => s.start)),
        toolEvent: tools ? stats(samples.flatMap((s) => s.tool)) : unavailable('no tool events in this scenario'),
        stop: stats(samples.map((s) => s.stop)),
        hookTotalPerTurn: stats(totals),
        stopToRecordVisible: visible.length === samples.length ? stats(visible) : { ...stats(visible), missing: samples.length - visible.length },
        loadAverage: { before: loadBefore, after: load() }
      }
      process.stdout.write(`  recorder ${mode} / ${name}: start p50 ${out[name].turnStart.p50}ms, stop p50 ${out[name].stop.p50}ms, turn total p50 ${out[name].hookTotalPerTurn.p50}ms\n`)
    }
    r.modes[mode] = out
  }
  const endStatus = daemon()
  const endUsage = endStatus.pid ? processUsage(endStatus.pid) : undefined
  await sleep(30_000)
  const idleUsage = endStatus.pid ? processUsage(endStatus.pid) : undefined
  r.daemon = endStatus.pid ? {
    pid: endStatus.pid, restartedDuringRun: startStatus.pid !== endStatus.pid,
    rssMiB: { afterWarmup: startUsage?.rssMiB, afterRun: endUsage?.rssMiB, after30sIdle: idleUsage?.rssMiB },
    cpuSecondsDuringRun: startUsage && endUsage && startStatus.pid === endStatus.pid ? Math.round((endUsage.cpuSeconds - startUsage.cpuSeconds) * 10) / 10 : unavailable('daemon restarted or not sampled'),
    cpuSecondsIn30sIdle: endUsage && idleUsage ? Math.round((idleUsage.cpuSeconds - endUsage.cpuSeconds) * 10) / 10 : unavailable('not sampled'),
    errorCount: endStatus.errorCount
  } : unavailable('recorder status reported no daemon pid')
  // L1 counts, untimed, after the resource sampling above (they restart the daemon).
  for (const [mode, env] of [['daemon fast path', {}], ['CLI fallback', { SCRY_RECORDER_TRANSPORT: 'direct' }]]) {
    for (const [name, tools, d] of scenarios) {
      r.modes[mode][name].gitCalls = await countGitCalls(work, provider, tools, env, d, undefined,
        () => tryRun(process.execPath, [scry, 'recorder', 'stop', '--workspace', work]))
      const g = r.modes[mode][name].gitCalls
      process.stdout.write(`  recorder ${mode} / ${name}: git calls start ${g.turnStart ?? '-'}, tools ${g.toolEvents ?? '-'}, stop ${g.stop ?? '-'}\n`)
    }
  }
  r.evidence = await evidenceDigest(work, provider, dirty)
  process.stdout.write(`  recorder evidence digest (dirty turn): ${r.evidence.digest ?? r.evidence.reason}\n`)
  tryRun(process.execPath, [scry, 'recorder', 'stop', '--workspace', work])
  const records = recordCount(work)
  const scryKiB = Number(tryRun('du', ['-sk', join(work, '.scry')])?.split(/\s+/)[0] ?? NaN)
  r.disk = { records, scryMiB: Math.round(scryKiB / 102.4) / 10, kibPerRecord: records ? Math.round(scryKiB / records) : null }
  r.hookSkips = skipCount(work)
  r.verify = tryRun(process.execPath, [scry, 'turns', 'verify', '--workspace', work]) !== undefined ? 'ok' : 'failed'
  tryRun(process.execPath, [scry, 'recorder', 'stop', '--workspace', work])
  report.recorder = r
  return r
}

function cloneTree(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  const args = platform() === 'darwin' ? ['-cR', from, to] : ['-a', '--reflink=auto', from, to]
  if (spawnSync('cp', args, { stdio: 'ignore' }).status !== 0) cpSync(from, to, { recursive: true })
}

// ---------- uploader (fake transport, temp HOME) ----------
function uploaderUser(protocol, root) {
  for (const d of ['home', 'state', 'config']) mkdirSync(join(root, d), { recursive: true })
  const control = join(root, 'control.json')
  writeFileSync(control, '{}')
  const env = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || tmpdir(), LANG: process.env.LANG || 'en_US.UTF-8',
    HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'),
    [protocol.transportEnv]: join(here, 'fake-transport.mjs'), SCRY_CLI_PATH: join(here, 'fake-scry.mjs'),
    FAKE_CONTROL: control, FAKE_LOG: join(root, 'transport.log'), FAKE_PROTOCOL: PROTOCOL_PATH
  }
  return { root, env, control: (v) => writeFileSync(control, JSON.stringify(v)) }
}

function uploaderWorkspace(user, name, contentSource) {
  const ws = join(user.root, name)
  mkdirSync(join(ws, '.scry', 'records'), { recursive: true })
  // Records reference tool/model bodies by hash under .scry/content; uploaders that inline
  // them fail with ENOENT if only the record JSON is copied.
  if (contentSource && existsSync(contentSource)) cloneTree(contentSource, join(ws, '.scry', 'content'))
  run('git', ['init', '-q', ws])
  writeFileSync(join(ws, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: `ws-${name}` }))
  return { ws: realpathSync(ws), seq: 0, name }
}

function commit(uploader, user, w, template, extraEnv = {}) {
  const sequence = ++w.seq
  const recordId = randomBytes(16).toString('hex')
  // Templates are reused, but a real record is the only record of its turn: give every copy its own
  // session and turn identity so the uploader never sees two recordIds claiming one Provider turn.
  const turnKey = recordId.slice(0, 16)
  const record = { ...template, schemaVersion: template.schemaVersion ?? 1, sequence, recordId, workspace: { id: `ws-${w.name}`, root: w.ws },
    sessionId: `perf-session-${turnKey}`, ...(template.providerTurnId !== undefined ? { providerTurnId: `perf-turn-${turnKey}` } : {}) }
  const raw = JSON.stringify(record) + '\n'   // same compact form the recorder writes
  const name = `${String(sequence).padStart(20, '0')}-${recordId}.json`
  writeFileSync(join(w.ws, '.scry', 'records', name), raw)
  const event = { schemaVersion: 2, event: 'record-committed', workspace: w.ws, provider: record.provider?.id ?? 'qoder', sessionId: record.sessionId ?? 'perf',
    sequence, recordId, recordPath: `records/${name}`, sha256: createHash('sha256').update(raw).digest('hex') }
  const t = now()
  try {
    execFileSync(process.execPath, [uploader, 'notify', '--workspace', w.ws], { input: JSON.stringify(event), env: { ...user.env, ...extraEnv }, stdio: ['pipe', 'ignore', 'pipe'] })
  } catch (error) {
    throw new Error(`uploader notify exited ${error.status}: ${String(error.stderr ?? error.message).trim().slice(0, 400)}`)
  }
  return { recordId, ms: now() - t, bytes: Buffer.byteLength(raw) }
}

const upStatus = (uploader, user, w) => JSON.parse(execFileSync(process.execPath, [uploader, 'status', '--workspace', w.ws, '--json'], { env: user.env, encoding: 'utf8' }))
function uploaderProcesses(uploader, w) {
  const out = tryRun('ps', ['-axo', 'pid=,rss=,pcpu=,command=']) ?? ''
  // Match by this run's unique temp workspace, not the CLI path: a bin symlink or wrapper may differ from the worker's path.
  return out.split('\n').filter((l) => l.includes(w.ws) && /\s_worker\b/.test(l))
    .map((l) => { const [pid, rss, pcpu] = l.trim().split(/\s+/); return { pid: Number(pid), rssMiB: Math.round(Number(rss) / 1024), pcpu: Number(pcpu) } })
}

// streaming: records arrive one by one, as hooks deliver them while workers upload.
// backlog: records pile up with no worker (as after a long offline period), then one wakeup drains them.
async function drain(uploader, user, w, count, templates, slowMs, mode) {
  user.control(slowMs ? { slowMs } : {})
  const commits = []
  const started = now()
  for (let i = 0; i < count; i++) commits.push(commit(uploader, user, w, templates[i % templates.length], mode === 'backlog' ? { SCRY_UPLOADER_NO_SPAWN: '1' } : {}))
  const committedMs = now() - started
  const drainStart = now()
  if (mode === 'backlog') execFileSync(process.execPath, [uploader, 'wakeup', '--workspace', w.ws], { env: user.env, stdio: 'ignore' })
  let peakWorkers = 0, peakRss = 0, peakCpu = 0, samples = 0
  const pendingTrail = []
  let done
  for (const deadline = now() + Number(opt('drain-timeout-min', 15)) * 60_000; now() < deadline; await sleep(250)) {
    const procs = uploaderProcesses(uploader, w)
    peakWorkers = Math.max(peakWorkers, procs.length)
    for (const p of procs) { peakRss = Math.max(peakRss, p.rssMiB); peakCpu = Math.max(peakCpu, p.pcpu) }
    samples++
    const s = upStatus(uploader, user, w)
    pendingTrail.push({ at: now(), pending: (s.outboxPending ?? 0) + (s.committedPending ?? 0), deadLetters: s.deadLetterRecords ?? 0 })
    if (pendingTrail.length > 2000) pendingTrail.shift()
    if (s.outboxPending === 0 && s.committedPending === 0) { done = s; break }
  }
  const drainMs = now() - drainStart
  user.control({})
  if (!done) {
    // Keep the uploader's own words: the reason is what a maintainer needs, a timeout alone is not.
    let last = {}
    try { last = upStatus(uploader, user, w) } catch (error) { last = { statusError: String(error.message).slice(0, 300) } }
    let health = {}
    try { health = JSON.parse(readFileSync(join(w.ws, '.scry', 'upload', 'health.json'), 'utf8')) } catch {}
    const deadDir = join(w.ws, '.scry', 'upload', 'dead-letter')
    const deadReasons = existsSync(deadDir) ? readdirSync(deadDir).slice(0, 3).map((n) => { try { const d = JSON.parse(readFileSync(join(deadDir, n), 'utf8')); return d.reason ?? d.status } catch { return n } }) : []
    const transportTail = existsSync(user.env.FAKE_LOG) ? readFileSync(user.env.FAKE_LOG, 'utf8').trim().split('\n').slice(-3) : ['no transport.log: the fake transport was never called']
    const unsupported = transportTail.map((l) => { try { return JSON.parse(l) } catch { return {} } }).find((e) => e.phase === 'unsupported')
    user.control({})
    if (unsupported) return { status: 'unavailable', reason: `uploader called tool ${unsupported.tool}, which the fake transport does not simulate (argument keys: ${unsupported.argumentKeys?.join(',')})`, committedMs: Math.round(committedMs), diagnostics: { transportTail } }
    // A timeout is still unavailable, but say whether the queue was still moving or stuck:
    // compare pending now with pending ~30 s earlier.
    const lastSample = pendingTrail.at(-1)
    const earlier = lastSample && [...pendingTrail].reverse().find((e) => lastSample.at - e.at >= 30_000)
    const progress = !lastSample || !earlier ? { state: 'unknown (fewer than 30 s of samples)' }
      : lastSample.pending < earlier.pending && lastSample.deadLetters === earlier.deadLetters
        ? { state: 'still draining', pendingAtTimeout: lastSample.pending, pending30sBefore: earlier.pending, recordsPerSecondLast30s: Math.round(((earlier.pending - lastSample.pending) / ((lastSample.at - earlier.at) / 1000)) * 10) / 10 }
        : { state: 'stuck', pendingAtTimeout: lastSample.pending, pending30sBefore: earlier.pending, deadLettersAdded: lastSample.deadLetters - earlier.deadLetters }
    return { status: 'unavailable', reason: `not drained within ${opt('drain-timeout-min', 15)} minutes (${progress.state})`, committedMs: Math.round(committedMs), progress,
      diagnostics: { outboxPending: last.outboxPending, committedPending: last.committedPending, deadLetterRecords: last.deadLetterRecords,
        lastError: last.lastError, statusError: last.statusError, healthStatus: health.status, healthLastErrorCode: health.lastErrorCode,
        healthLastFailure: health.lastFailure ?? health.lastFailureMessage, deadLetterReasons: deadReasons, transportTail } }
  }
  const logLines = existsSync(user.env.FAKE_LOG) ? readFileSync(user.env.FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } }) : []
  const requests = logLines.filter((e) => e.phase === 'end').length
  const starts = logLines.filter((e) => e.phase === 'start' && typeof e.wireBytes === 'number')
  const capabilityCalls = logLines.filter((e) => e.phase === 'capability').length
  const total = mode === 'backlog' ? drainMs : committedMs + drainMs
  return {
    status: 'measured', mode, records: count, fakeLatencyMs: slowMs, notify: stats(commits.map((c) => c.ms)),
    commitPhaseMs: Math.round(committedMs), drainAfterLastCommitMs: Math.round(drainMs),
    recordsPerSecond: Math.round((count / (total / 1000)) * 10) / 10,
    requestKiB: starts.length ? stats(starts.map((e) => e.wireBytes / 1024), 'KiB') : unavailable('fake transport did not log request sizes'),
    capabilityCalls, transportRequests: requests, recordsPerRequest: requests ? Math.round((count / requests) * 10) / 10 : null, deadLetters: done.deadLetterRecords,
    worker: { peakConcurrent: peakWorkers, peakRssMiB: peakRss || null, peakPcpu: peakCpu || null, psSamples: samples }
  }
}

async function uploaderPhase(uploader, report) {
  const protocol = JSON.parse(readFileSync(PROTOCOL_PATH, 'utf8'))
  // Use a real record from the recorder phase as the payload so sizes match this repository.
  const work = opt('work') && resolve(opt('work'))
  let templates = [{ provider: { id: 'qoder' }, sessionId: 'perf', user: { status: 'available', value: { text: 'x'.repeat(400) } } }]
  let templateSource = 'synthetic 0.4 KiB record (no recorder-phase records found)'
  const recordsDir = work && join(work, '.scry', 'records')
  const contentSource = work && join(work, '.scry', 'content')
  if (recordsDir && existsSync(recordsDir)) {
    const files = readdirSync(recordsDir).filter((n) => n.endsWith('.json')).sort().map((n) => join(recordsDir, n))
    if (files.length) {
      // Cycle through every recorder-phase record so the size mix matches this repository.
      templates = files.map((f) => JSON.parse(readFileSync(f, 'utf8')))
      const sizes = files.map((f) => statSync(f).size / 1024).sort((a, b) => a - b)
      templateSource = `${files.length} recorder-phase records cycled (median ${Math.round(sizes[Math.floor(sizes.length / 2)])} KiB, max ${Math.round(sizes.at(-1))} KiB)`
    }
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-perf-uploader-')))
  const u = { contentBlobs: contentSource && existsSync(contentSource) ? 'copied from recorder phase' : 'none (no recorder-phase content)', version: tryRun(process.execPath, [uploader, 'version']) ?? tryRun(process.execPath, [uploader, '--version']), payload: templateSource, transport: 'fake transport (no network); fakeLatencyMs emulates a slow server', runs: {} }
  report.uploader = u   // keep finished runs even if a later one fails
  const stopWorkers = (w) => { for (const p of uploaderProcesses(uploader, w)) try { process.kill(p.pid, 'SIGKILL') } catch {} }
  try {
    // Fail closed before any record exists: an uploader that ignores protocol.transportEnv would use
    // the real transport, and every synthetic record below would be uploaded for real.
    {
      const user = uploaderUser(protocol, join(root, 'preflight'))
      const w = uploaderWorkspace(user, 'preflight')
      spawnSync(process.execPath, [uploader, 'doctor', '--workspace', w.ws, '--json'], { env: user.env, stdio: 'ignore', timeout: 60_000 })
      const invoked = existsSync(user.env.FAKE_LOG) && readFileSync(user.env.FAKE_LOG, 'utf8').includes('"phase":"invoke"')
      if (!invoked) throw new Error(`uploader did not call the fake transport (protocol.json transportEnv=${protocol.transportEnv}); fill protocol.json with the real values from the uploader source. Stopped before committing any record, nothing was uploaded`)
      u.fakeTransport = `confirmed via ${protocol.transportEnv}`
      console.log(`  fake transport: confirmed via ${protocol.transportEnv}`)
    }
    // Hook-path latency: notify only, background upload paused by a slow fake server.
    {
      const user = uploaderUser(protocol, join(root, 'notify'))
      const w = uploaderWorkspace(user, 'notify', contentSource)
      user.control({ slowMs: 60_000 })
      const times = []
      for (let i = 0; i < Math.max(20, ROUNDS * 4); i++) times.push(commit(uploader, user, w, templates[i % templates.length]).ms)
      u.notifyWhileUploading = stats(times)
      stopWorkers(w)
    }
    for (const [mode, count, slowMs] of [['streaming', 100, 0], ['streaming', 100, 250], ['backlog', 100, 0], ['backlog', 500, 0], ['backlog', 500, 250]]) {
      const key = `${mode} ${count}, fake latency ${slowMs}ms`
      const user = uploaderUser(protocol, join(root, `${mode}-${count}-${slowMs}`))
      const w = uploaderWorkspace(user, `${mode}${count}`, contentSource)
      const loadBefore = load()
      const result = await drain(uploader, user, w, count, templates, slowMs, mode)
      stopWorkers(w)   // an undrained run must not keep writing into the next run or the cleanup
      const uploadKiB = Number(tryRun('du', ['-sk', join(w.ws, '.scry', 'upload')])?.split(/\s+/)[0] ?? NaN)
      u.runs[key] = { ...result, uploadDirKiBPerRecord: Math.round((uploadKiB / count) * 10) / 10, loadAverage: { before: loadBefore, after: load() } }
      process.stdout.write(result.status === 'measured'
        ? `  uploader ${key}: drain ${result.drainAfterLastCommitMs}ms after last commit, ${result.recordsPerSecond} rec/s, ${result.transportRequests} requests\n`
        : `  uploader ${key}: unavailable (${result.reason}; ${result.progress?.state === 'still draining' ? `pending ${result.progress.pending30sBefore} -> ${result.progress.pendingAtTimeout} in the last 30 s, ${result.progress.recordsPerSecondLast30s} rec/s; rerun with a longer --drain-timeout-min` : `lastError ${JSON.stringify(result.diagnostics?.lastError ?? null)}`})\n`)
    }
  } finally {
    // Cleanup must never replace the real error: workers that were still running can recreate files.
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }) } catch (error) {
      u.leftover = { path: root, reason: String(error.message).slice(0, 200) }
      console.error(`could not remove ${root}: ${error.message} (left in place)`)
    }
  }
  report.uploader = u
}

// ---------- uploader hook wrapper on the Provider's critical path ----------
// `<uploader> init` replaces `.scry/provider-hook.sh` with a wrapper that runs the original Scry
// bridge and then, on UserPromptSubmit and Stop, the `wakeup` launcher synchronously. It also sets
// the recorder commit hook to the uploader's `notify` launcher: with the recorder daemon that runs
// after the daemon replied; in CLI fallback it is drained inline on the hook path (bounded).
// This phase measures the same turns with and without the wrapper on the same copy, plus the
// `wakeup` launcher alone. Everything runs under a temporary HOME/XDG and the fake transport;
// the copy's existing `.scry` and config are put aside first and restored afterwards.
const HOOKWRAP_SCENARIOS = [['clean, 0 tools', 0], ['clean, 5 tools', 5]]
const HOOKWRAP_FIELDS = ['turnStart', 'toolEvent', 'stop', 'hookTotalPerTurn', 'stopToRecordVisible']
const COUNT_FIELDS = ['turnStart', 'toolEvents', 'stop', 'total']
const PROVIDER_CONFIG_DIRS = ['.qoder', '.codex', '.opencode', '.claude']

async function measureTurns(work, provider, exactEnv, stop) {
  await turn(work, provider, 1, {}, undefined, exactEnv)   // warm-up: starts the daemon, not counted
  const modes = {}
  for (const [mode, env] of [['daemon fast path', {}], ['CLI fallback', { SCRY_RECORDER_TRANSPORT: 'direct' }]]) {
    const out = {}
    for (const [name, tools] of HOOKWRAP_SCENARIOS) {
      const samples = []
      for (let i = 0; i < ROUNDS; i++) samples.push(await turn(work, provider, tools, env, undefined, exactEnv))
      const visible = samples.map((s) => s.visibleMs).filter((v) => v !== undefined)
      out[name] = {
        turnStart: stats(samples.map((s) => s.start)),
        toolEvent: tools ? stats(samples.flatMap((s) => s.tool)) : unavailable('no tool events in this scenario'),
        stop: stats(samples.map((s) => s.stop)),
        hookTotalPerTurn: stats(samples.map((s) => s.start + s.tool.reduce((a, b) => a + b, 0) + s.stop)),
        stopToRecordVisible: visible.length === samples.length ? stats(visible) : { ...stats(visible), missing: samples.length - visible.length }
      }
    }
    modes[mode] = out
  }
  for (const [mode, env] of [['daemon fast path', {}], ['CLI fallback', { SCRY_RECORDER_TRANSPORT: 'direct' }]])
    for (const [name, tools] of HOOKWRAP_SCENARIOS) modes[mode][name].gitCalls = await countGitCalls(work, provider, tools, env, undefined, exactEnv, stop)
  return modes
}

// `.scry` (recorder data, sockets) is moved aside so the phase starts empty. `scry.config.json` and the
// Provider config dirs stay in place: they may be tracked by git (moving them would show up as
// deletions in every snapshot) and the config carries the workload's repository settings. Byte copies
// are saved and put back afterwards, undoing what `scry init` / `<uploader> init` merged into them.
function setAside(work, saved) {
  mkdirSync(saved, { recursive: true })
  const moved = [], copied = []
  if (existsSync(join(work, '.scry'))) { renameSync(join(work, '.scry'), join(saved, '.scry')); moved.push('.scry') }
  for (const entry of ['scry.config.json', ...PROVIDER_CONFIG_DIRS]) {
    if (!existsSync(join(work, entry))) continue
    cpSync(join(work, entry), join(saved, 'copies', entry), { recursive: true, verbatimSymlinks: true })
    copied.push(entry)
  }
  // The copy has no commit hook of its own (prepareCopy removed it); keep it that way for "plain".
  const config = join(work, 'scry.config.json')
  if (existsSync(config)) { const v = JSON.parse(readFileSync(config, 'utf8')); if (v.commitHook) { delete v.commitHook; writeFileSync(config, JSON.stringify(v, null, 2) + '\n') } }
  return { moved, copied }
}

function restoreAside(work, saved, { moved, copied }) {
  for (const entry of ['.scry', 'scry.config.json', ...PROVIDER_CONFIG_DIRS]) rmSync(join(work, entry), { recursive: true, force: true })
  for (const entry of moved) renameSync(join(saved, entry), join(work, entry))
  for (const entry of copied) cpSync(join(saved, 'copies', entry), join(work, entry), { recursive: true, verbatimSymlinks: true })
  rmSync(saved, { recursive: true, force: true })
}

async function hookwrapPhase(scry, uploader, work, report) {
  const provider = opt('provider', 'qoder')
  const protocol = JSON.parse(readFileSync(PROTOCOL_PATH, 'utf8'))
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-perf-hookwrap-')))
  const h = { provider, uploaderScry: opt('uploader-scry') ? 'override (--uploader-scry)' : 'uploader bundled recorder',
    note: 'same synthetic turns through the copy\'s provider-hook.sh, first plain (scry init) then wrapped (uploader init); temp HOME/XDG, fake transport', modes: {} }
  report.hookwrap = h
  const user = uploaderUser(protocol, join(root, 'user'))
  // Exact environment for every hook, recorder and uploader call: no real HOME, XDG, grants dir or
  // SCRY_CLI_PATH may leak in, so nothing lands in the user's registry, admission state or launchd.
  const env = { ...user.env, SCRY_GRANT_DIR: join(root, 'grants') }
  if (opt('uploader-scry')) env.SCRY_CLI_PATH = resolve(opt('uploader-scry'))
  else delete env.SCRY_CLI_PATH
  // Git must behave as it does for the user (e.g. core.checkStat, fsmonitor): with the temporary
  // HOME it would lose the global config and re-hash the copy on every snapshot. Git only reads it.
  const realHome = process.env.HOME ?? ''
  const gitGlobal = [process.env.GIT_CONFIG_GLOBAL, join(realHome, '.gitconfig'), join(process.env.XDG_CONFIG_HOME || join(realHome, '.config'), 'git', 'config')]
    .find((f) => f && existsSync(f))
  if (gitGlobal) env.GIT_CONFIG_GLOBAL = gitGlobal
  h.gitGlobalConfig = gitGlobal ? 'user global config (read only)' : 'none found'
  const saved = join(work, '.git', 'scry-perf-hookwrap-saved')
  if (existsSync(saved)) throw new Error(`${saved} exists from an interrupted hookwrap run; restore or remove it before rerunning`)
  const stopRecorder = () => tryRun(process.execPath, [scry, 'recorder', 'stop', '--workspace', work], { env })
  const killWorkers = () => {
    const out = tryRun('ps', ['-axo', 'pid=,command=']) ?? ''
    for (const l of out.split('\n')) if ((l.includes(work) || l.includes(root)) && /\s_(worker|recover)\b/.test(l)) try { process.kill(Number(l.trim().split(/\s+/)[0]), 'SIGKILL') } catch {}
  }
  tryRun(process.execPath, [scry, 'recorder', 'stop', '--workspace', work])   // a daemon left with the real environment
  const moved = setAside(work, saved)
  h.copySetAside = moved
  try {
    // Fail closed before installing anything: the uploader must call the fake transport.
    {
      const w = uploaderWorkspace(user, 'preflight')
      spawnSync(process.execPath, [uploader, 'doctor', '--workspace', w.ws, '--json'], { env, stdio: 'ignore', timeout: 60_000 })
      const invoked = existsSync(env.FAKE_LOG) && readFileSync(env.FAKE_LOG, 'utf8').includes('"phase":"invoke"')
      if (!invoked) throw new Error(`uploader did not call the fake transport (protocol.json transportEnv=${protocol.transportEnv}); stopped before uploader init, nothing installed or uploaded`)
      h.fakeTransport = `confirmed via ${protocol.transportEnv}`
      console.log(`  fake transport: confirmed via ${protocol.transportEnv}`)
    }
    // Plain: Scry's own hook script.
    node(scry, ['init', '--workspace', work, '--providers', provider, '--json'], { env })
    const plain = await measureTurns(work, provider, env, stopRecorder)
    stopRecorder()
    // Wrapped: install the uploader the way a user does.
    const init = spawnSync(process.execPath, [uploader, 'init', '--providers', provider, '--json'], { cwd: work, env, encoding: 'utf8', timeout: 180_000 })
    if (init.status !== 0) {
      h.status = 'unavailable'
      h.reason = `uploader init failed (exit ${init.status}): ${String(init.stderr || init.stdout || init.error?.message).trim().slice(0, 400)}`
      h.plainOnly = plain
      return
    }
    const config = JSON.parse(readFileSync(join(work, 'scry.config.json'), 'utf8'))
    const entry = config.commitHook?.entry
    const bridge = readFileSync(join(work, '.scry', 'provider-hook.sh'), 'utf8')
    h.wrapperInstalled = existsSync(join(work, '.scry', 'provider-hook-scry.sh')) && bridge !== readFileSync(join(work, '.scry', 'provider-hook-scry.sh'), 'utf8')
    if (!h.wrapperInstalled) throw new Error('uploader init succeeded but .scry/provider-hook.sh was not wrapped')
    const wrapped = await measureTurns(work, provider, env, stopRecorder)
    for (const [mode] of Object.entries(plain)) {
      h.modes[mode] = {}
      for (const [name] of HOOKWRAP_SCENARIOS) {
        const overhead = {}
        for (const f of HOOKWRAP_FIELDS) {
          const a = plain[mode][name][f], b = wrapped[mode][name][f]
          overhead[f] = a?.status === 'measured' && b?.status === 'measured'
            ? { status: 'measured', unit: 'ms', n: Math.min(a.n, b.n), p50: Math.round((b.p50 - a.p50) * 10) / 10, p95: Math.round((b.p95 - a.p95) * 10) / 10 }
            : unavailable(`plain ${a?.status ?? 'missing'}, wrapped ${b?.status ?? 'missing'}`)
        }
        const pc = plain[mode][name].gitCalls, wc = wrapped[mode][name].gitCalls
        const gitCallsAdded = pc?.status === 'measured' && wc?.status === 'measured'
          ? { status: 'measured', unit: 'count', ...Object.fromEntries(COUNT_FIELDS.map((f) => [f, wc[f] - pc[f]])) } : unavailable('git call count missing on one side')
        h.modes[mode][name] = { plain: plain[mode][name], wrapped: wrapped[mode][name], overhead, gitCallsAdded }
      }
    }
    // The wakeup launcher alone, as the wrapper calls it.
    const launcher = entry ? join(work, dirname(entry), 'wakeup') : undefined
    if (launcher && existsSync(launcher)) {
      const times = []
      for (let i = 0; i < Math.max(10, ROUNDS * 2); i++) {
        const t = now()
        spawnSync(launcher, [], { env, stdio: 'ignore', timeout: 60_000 })
        times.push(now() - t)
      }
      h.wakeup = stats(times)
    } else h.wakeup = unavailable(`no wakeup launcher next to the commit hook entry (${entry ?? 'no commitHook'})`)
    // The wrapped turns must still reach the (fake) server.
    const deadline = now() + 120_000
    let s = {}
    for (; now() < deadline; await sleep(1000)) {
      try { s = JSON.parse(execFileSync(process.execPath, [uploader, 'status', '--workspace', work, '--json'], { env, encoding: 'utf8' })) } catch { s = {} }
      if (s.outboxPending === 0 && s.committedPending === 0) break
    }
    const receiptsDir = join(work, '.scry', 'upload', 'receipts')
    const receipts = existsSync(receiptsDir) ? readdirSync(receiptsDir).filter((n) => n.endsWith('.json')).map((n) => { try { return JSON.parse(readFileSync(join(receiptsDir, n), 'utf8')) } catch { return {} } }) : []
    h.uploads = { records: recordCount(work), receipts: receipts.length,
      uploaded: receipts.filter((r) => r.status === 'uploaded' && ['inserted', 'duplicated'].includes(r.remoteStatus)).length,
      outboxPending: s.outboxPending, committedPending: s.committedPending, deadLetters: s.deadLetterRecords }
    h.hookSkips = skipCount(work)
    for (const [mode, scenarios] of Object.entries(h.modes)) for (const [name, m] of Object.entries(scenarios))
      process.stdout.write(`  hookwrap ${mode} / ${name}: turn total p50 ${m.plain.hookTotalPerTurn.p50} -> ${m.wrapped.hookTotalPerTurn.p50} ms (overhead ${m.overhead.hookTotalPerTurn.p50 ?? 'unavailable'} ms)\n`)
    process.stdout.write(`  hookwrap wakeup launcher: p50 ${h.wakeup.p50 ?? 'unavailable'} ms; uploads ${h.uploads.uploaded}/${h.uploads.records} records via fake transport\n`)
  } finally {
    stopRecorder()
    killWorkers()
    restoreAside(work, saved, moved)
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }) } catch (error) {
      h.leftover = { path: root, reason: String(error.message).slice(0, 200) }
    }
  }
}

// ---------- optional end-to-end with a real Provider ----------
async function e2e() {
  const work = resolve(opt('work'))
  if (!existsSync(join(work, MARKER))) throw new Error('--work must be a perf-bench copy')
  const template = opt('cmd')
  const runs = Number(opt('runs', 5))
  if (!template || !template.includes('{prompt}')) throw new Error('--cmd must contain {prompt}')
  const results = { on: [], off: [] }
  // Alternate on/off so drift in model latency hits both sides equally.
  for (let i = 0; i < runs; i++) {
    for (const mode of i % 2 ? ['off', 'on'] : ['on', 'off']) {
      const prompt = `[perf-e2e-${mode}-${i}] 只回答“好”，不要调用任何工具。`
      const cmd = template.replaceAll('{prompt}', prompt.replaceAll("'", "'\\''"))
      const t = now()
      const r = spawnSync('/bin/sh', ['-c', cmd], { cwd: work, env: { ...process.env, ...(mode === 'off' ? { SCRY_RECORDER_ENABLED: '0' } : {}) }, stdio: 'ignore' })
      results[mode].push({ ms: now() - t, exit: r.status })
    }
  }
  const out = {
    at: new Date().toISOString(), cmd: template, runs, note: 'model latency dominates; record the difference, do not gate on it',
    recorderOn: stats(results.on.filter((r) => r.exit === 0).map((r) => r.ms)), recorderOff: stats(results.off.filter((r) => r.exit === 0).map((r) => r.ms)),
    failures: [...results.on, ...results.off].filter((r) => r.exit !== 0).length
  }
  const path = join(outDir, `e2e-${out.at.replace(/[:.]/g, '-')}.json`)
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n')
  console.log(JSON.stringify(out, null, 2))
  console.log(`written: ${path}`)
}

// ---------- report ----------
function markdown(report) {
  const lines = [`# Scry 性能基线 ${report.environment.at.slice(0, 10)}`, '', '## 环境', '', '```json', JSON.stringify({ environment: report.environment, versions: report.versions, repository: report.repository }, null, 2), '```', '']
  const gitCell = (g) => g?.status === 'measured' ? `${g.turnStart} / ${g.toolEvents} / ${g.stop}` : `unavailable${g?.reason ? `（${g.reason}）` : ''}`
  const cell = (m) => m?.status === 'measured' ? `${m.p50} / ${m.p95}` : `unavailable${m?.reason ? `（${m.reason}）` : ''}`
  if (report.recorder?.status === 'unavailable') lines.push('## Recorder hook 路径', '', `unavailable：${report.recorder.reason}`, '')
  if (report.recorder?.modes) {
    lines.push('## Recorder hook 路径（毫秒，p50 / p95）', '', `Provider 形状：${report.recorder.provider}；${report.recorder.note}；每格 ${ROUNDS} 轮。`, '')
    for (const [mode, scenarios] of Object.entries(report.recorder.modes)) {
      lines.push(`### ${mode}`, '', '| 场景 | 轮次开始 | 单个工具事件 | 轮次结束 | 每轮 hook 合计 | 结束到记录落盘 | git 调用（开始 / 全部工具 / 结束） |', '| --- | --- | --- | --- | --- | --- | --- |')
      for (const [name, m] of Object.entries(scenarios)) lines.push(`| ${name} | ${cell(m.turnStart)} | ${cell(m.toolEvent)} | ${cell(m.stop)} | ${cell(m.hookTotalPerTurn)} | ${cell(m.stopToRecordVisible)} | ${gitCell(m.gitCalls)} |`)
      lines.push('')
    }
    lines.push('```json', JSON.stringify({ daemon: report.recorder.daemon, disk: report.recorder.disk, hookSkips: report.recorder.hookSkips, verify: report.recorder.verify }, null, 2), '```', '')
  }
  if (report.uploader?.status === 'unavailable') lines.push('## Uploader', '', `unavailable：${report.uploader.reason}（下表只含失败前完成的场景）`, '')
  if (report.uploader) {
    lines.push('## Uploader（假传输层，不联网）', '', `载荷：${report.uploader.payload}`, '', `hook 路径 notify（上传进行中）：${cell(report.uploader.notifyWhileUploading)} ms`, '',
      'streaming：记录逐条到达、边提交边上传；backlog：先积压（不拉起 worker），再一次唤醒排空。', '',
      '| 场景 | notify p50 / p95 | 提交阶段 | 最后一条提交后排空 | 条/秒 | 请求数（条/请求） | 能力查询次数 | 请求体 KiB p50 / p95 | worker 峰值数 | worker 峰值 RSS | upload 目录 KiB/条 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const [name, m] of Object.entries(report.uploader.runs ?? {})) {
      if (m.status !== 'measured') { lines.push(`| ${name} | unavailable（${m.reason}${m.progress ? `；${JSON.stringify(m.progress).replaceAll('|', '\\|')}` : ''}${m.diagnostics ? `；${JSON.stringify(m.diagnostics).replaceAll('|', '\\|')}` : ''}） | | | | | | | | | |`); continue }
      lines.push(`| ${name} | ${cell(m.notify)} | ${m.commitPhaseMs} ms | ${m.drainAfterLastCommitMs} ms | ${m.recordsPerSecond} | ${m.transportRequests}（${m.recordsPerRequest}） | ${m.capabilityCalls ?? 'unavailable'} | ${cell(m.requestKiB)} | ${m.worker.peakConcurrent} | ${m.worker.peakRssMiB ? `${m.worker.peakRssMiB} MiB` : 'unavailable（采样时没有 worker）'} | ${m.uploadDirKiBPerRecord} |`)
    }
    lines.push('')
  }
  if (report.hookwrap?.status === 'unavailable') lines.push('## Uploader hook 包装（每轮关键路径）', '', `unavailable：${report.hookwrap.reason}`, '')
  if (report.hookwrap?.modes && Object.keys(report.hookwrap.modes).length) {
    const h = report.hookwrap
    lines.push('## Uploader hook 包装（每轮关键路径，毫秒 p50 / p95）', '',
      `Provider 形状：${h.provider}；uploader 读记录用：${h.uploaderScry}；${h.note}；每格 ${ROUNDS} 轮。“增加”= 包装后 − 包装前（同一副本、同一次运行）。`, '',
      `wakeup 启动器单独计时：${cell(h.wakeup)}；上传核对：${h.uploads?.uploaded ?? 'unavailable'}/${h.uploads?.records ?? 'unavailable'} 条经假传输层上传，死信 ${h.uploads?.deadLetters ?? 'unavailable'}，hook-skip ${h.hookSkips ?? 'unavailable'}`, '')
    const label = { turnStart: '轮次开始', toolEvent: '单个工具事件', stop: '轮次结束', hookTotalPerTurn: '每轮 hook 合计', stopToRecordVisible: '结束到记录落盘' }
    for (const [mode, scenarios] of Object.entries(h.modes)) {
      lines.push(`### ${mode}`, '', '| 场景 | 指标 | 包装前 | 包装后 | 增加 |', '| --- | --- | --- | --- | --- |')
      for (const [name, m] of Object.entries(scenarios)) {
        for (const f of HOOKWRAP_FIELDS) lines.push(`| ${name} | ${label[f]} | ${cell(m.plain[f])} | ${cell(m.wrapped[f])} | ${cell(m.overhead[f])} |`)
        lines.push(`| ${name} | git 调用（开始 / 全部工具 / 结束） | ${gitCell(m.plain.gitCalls)} | ${gitCell(m.wrapped.gitCalls)} | ${gitCell(m.gitCallsAdded)} |`)
      }
      lines.push('')
    }
  }
  lines.push('## 说明', '', '- 毫秒值是本机在记录的负载下的墙钟时间，只和同一台机器上的后续结果比较。', '- 这是受控测量（L2），不是日常使用下的结论；不写入 `scripts/performance-ratchet.json`。', '- `unavailable` 表示没测到，原因写在旁边，不等于 0。', '')
  return lines.join('\n')
}

async function baseline() {
  const scry = opt('scry') && resolve(opt('scry'))
  const uploader = opt('uploader') && resolve(opt('uploader'))
  const only = opt('only')
  const listed = opt('phases') ? opt('phases').split(',').map((p) => p.trim()).filter(Boolean) : only ? [only] : undefined
  for (const p of listed ?? []) if (!['recorder', 'uploader', 'hookwrap'].includes(p)) throw new Error('--only/--phases take recorder, uploader, hookwrap')
  const phases = listed ?? ['recorder', 'uploader', ...(scry && uploader && !argv.includes('--skip-hookwrap') ? ['hookwrap'] : [])]
  // --label names the build under test (e.g. "base 1a2b3c" / "cand 4d5e6f"); perf-ab shows it.
  const report = { environment: environment(), versions: {}, rounds: ROUNDS, ...(opt('label') ? { label: opt('label') } : {}) }
  let work
  if (phases.includes('recorder') || phases.includes('hookwrap')) {
    if (!opt('work') || !scry) throw new Error('recorder and hookwrap phases need --work and --scry')
    const target = resolve(opt('work'))
    // hookwrap alone reuses an existing copy as is (it sets the copy's .scry aside and restores it);
    // the recorder phase always starts from a reset copy.
    if (!phases.includes('recorder') && existsSync(join(target, MARKER))) work = target
    else {
      if (!opt('source')) throw new Error('a new or reset copy needs --source')
      work = prepareCopy(opt('source'), target)
    }
    const copyInfo = JSON.parse(readFileSync(join(work, MARKER), 'utf8'))
    report.versions.scry = tryRun(process.execPath, [scry, 'version'])
    // --workload-name keeps a private repository name out of results that may be shared.
    report.repository = { name: opt('workload-name', basename(copyInfo.source)), copy: work, copyInfo, ...repoStats(work) }
  }
  if (phases.includes('recorder')) {
    console.log(`recorder phase on ${work} (${report.repository.tracked} tracked files)`)
    try { await recorderPhase(scry, work, report) } catch (error) {
      report.recorder = unavailable(`recorder phase failed: ${error.message}`)
      console.error(`recorder phase failed: ${error.message}`)
    }
  }
  if (phases.includes('uploader')) {
    if (!uploader) throw new Error('uploader phase needs --uploader')
    console.log('uploader phase (fake transport)')
    try { await uploaderPhase(uploader, report) } catch (error) {
      report.uploader = { ...(report.uploader ?? {}), status: 'unavailable', reason: `uploader phase failed: ${error.message}` }
      console.error(`uploader phase failed: ${error.message}`)
    }
    report.versions.uploader = report.uploader?.version ?? tryRun(process.execPath, [uploader, 'version'])
  }
  if (phases.includes('hookwrap')) {
    if (!uploader) throw new Error('hookwrap phase needs --uploader')
    console.log(`hookwrap phase on ${work} (uploader hook wrapper, fake transport)`)
    report.versions.uploader = report.versions.uploader ?? tryRun(process.execPath, [uploader, 'version'])
    try { await hookwrapPhase(scry, uploader, work, report) } catch (error) {
      report.hookwrap = { ...(report.hookwrap ?? {}), status: 'unavailable', reason: `hookwrap phase failed: ${error.message}` }
      console.error(`hookwrap phase failed: ${error.message}`)
    }
  }
  report.environment.loadAverageAtEnd = load()
  const stamp = report.environment.at.replace(/[:.]/g, '-')
  const jsonPath = join(outDir, `baseline-${stamp}.json`)
  // Results may be pushed to a shared branch: never write the user's home directory (it names the user).
  const home = process.env.HOME && process.env.HOME !== '/' ? process.env.HOME : undefined
  const redact = (text) => (home ? text.split(home).join('~') : text)
  if (report.repository) { report.repository.copyInfo = { ...report.repository.copyInfo, source: opt('workload-name') ? `<${opt('workload-name')}>` : report.repository.copyInfo.source } }
  writeFileSync(jsonPath, redact(JSON.stringify(report, null, 2)) + '\n')
  writeFileSync(join(outDir, `baseline-${stamp}.md`), redact(markdown(report)))
  console.log(`written: ${jsonPath}\nwritten: ${jsonPath.replace(/\.json$/, '.md')}`)
}

try {
  if (sub === 'e2e') await e2e()
  else await baseline()
} catch (error) {
  console.error(`perf-bench: ${error.message}`)
  process.exit(1)
}
