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
//     --uploader <uploader dist/cli.js> [--rounds 7] [--out <dir>] [--only recorder|uploader]
//   node perf-bench.mjs e2e --work <copy dir> --cmd '<provider command with {prompt}>' --runs 5
//
// Milliseconds are wall time on this machine under its current load; the report
// records load average per phase. Run nothing else heavy at the same time and do
// not run two copies of this script at once (it takes a lock).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  return { status: 'measured', unit, n: s.length, p50: round(q(0.5)), p95: round(q(0.95)), min: round(s[0]), max: round(s.at(-1)) }
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
  const timings = []
  for (let i = 0; i < 5; i++) { const t = now(); run('git', ['-C', work, 'status', '--porcelain=v2', '-uall']); timings.push(now() - t) }
  return { tracked, untracked, ignoredEntries: ignored, commits, gitDirMiB: Math.round(gitDirKiB / 1024), submodules, gitStatus: stats(timings) }
}

// ---------- recorder hook path ----------
function hook(work, provider, event, payload, env = {}) {
  const t = now()
  const r = spawnSync('/bin/sh', [join(work, '.scry/provider-hook.sh'), provider, event], {
    input: JSON.stringify(payload), env: { ...process.env, SCRY_RECORDER_MANAGED: '0', ...env }, stdio: ['pipe', 'ignore', 'pipe']
  })
  const ms = now() - t
  if (r.status !== 0) throw new Error(`hook ${provider} ${event} exited ${r.status}: ${String(r.stderr).slice(0, 300)}`)
  return ms
}
const recordCount = (work) => existsSync(join(work, '.scry/records')) ? readdirSync(join(work, '.scry/records')).filter((n) => n.endsWith('.json')).length : 0
const skipCount = (work) => existsSync(join(work, '.scry/logs/hook-skip.log')) ? readFileSync(join(work, '.scry/logs/hook-skip.log'), 'utf8').split('\n').filter(Boolean).length : 0

async function turn(work, provider, tools, env, dirty) {
  const session = `perf-${provider}-${randomBytes(4).toString('hex')}`
  let clock = Date.now()
  const ts = () => new Date(++clock).toISOString()
  const base = { session_id: session, cwd: work }
  const times = { start: 0, tool: [], stop: 0, visibleMs: undefined }
  const before = recordCount(work)
  times.start = hook(work, provider, 'UserPromptSubmit', { ...base, prompt: `[perf-bench] ${session}`, timestamp: ts() }, env)
  if (dirty) dirty.apply()
  for (let i = 0; i < tools; i++) {
    const id = `call-${i}`
    times.tool.push(hook(work, provider, 'PreToolUse', { ...base, tool_name: 'Bash', tool_use_id: id, tool_input: { command: `echo ${i}` }, timestamp: ts() }, env))
    times.tool.push(hook(work, provider, 'PostToolUse', { ...base, tool_name: 'Bash', tool_use_id: id, tool_response: `out ${i}\n`.repeat(20), timestamp: ts() }, env))
  }
  const stopAt = now()
  times.stop = hook(work, provider, 'Stop', { ...base, assistant_response: 'done', timestamp: ts() }, env)
  // A record that is accepted but committed later still makes the user wait for evidence; measure it.
  for (const deadline = now() + 30_000; now() < deadline; await sleep(20)) {
    if (recordCount(work) > before) { times.visibleMs = now() - stopAt; break }
  }
  if (dirty) dirty.restore()
  return times
}

function dirtyTree(work) {
  const files = run('git', ['-C', work, 'ls-files', '-z']).split('\0').filter((f) => f && /\.(ts|tsx|js|mjs|md|json|py|go|rs|java|kt|swift|c|cc|cpp|h)$/.test(f))
    .filter((f) => { try { return statSync(join(work, f)).size < 200_000 } catch { return false } }).slice(0, 20)
  const scratch = join(work, 'scry-perf-bench-scratch')
  return {
    modified: files.length,
    apply() {
      for (const f of files) appendFileSync(join(work, f), '\n// scry perf bench\n')
      mkdirSync(scratch, { recursive: true })
      for (let i = 0; i < 50; i++) writeFileSync(join(scratch, `f${i}.txt`), `bench ${i}\n`.repeat(50))
    },
    restore() {
      if (files.length) run('git', ['-C', work, 'checkout', '--', ...files])
      rmSync(scratch, { recursive: true, force: true })
    }
  }
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
    [`dirty (${dirty.modified} modified + 50 new files), 5 tools`, 5, dirty]
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
    FAKE_CONTROL: control, FAKE_LOG: join(root, 'transport.log'), FAKE_PROTOCOL: join(here, 'protocol.json')
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
  let done
  for (const deadline = now() + Number(opt('drain-timeout-min', 15)) * 60_000; now() < deadline; await sleep(250)) {
    const procs = uploaderProcesses(uploader, w)
    peakWorkers = Math.max(peakWorkers, procs.length)
    for (const p of procs) { peakRss = Math.max(peakRss, p.rssMiB); peakCpu = Math.max(peakCpu, p.pcpu) }
    samples++
    const s = upStatus(uploader, user, w)
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
    return { status: 'unavailable', reason: `not drained within ${opt('drain-timeout-min', 15)} minutes`, committedMs: Math.round(committedMs),
      diagnostics: { outboxPending: last.outboxPending, committedPending: last.committedPending, deadLetterRecords: last.deadLetterRecords,
        lastError: last.lastError, statusError: last.statusError, healthStatus: health.status, healthLastErrorCode: health.lastErrorCode,
        healthLastFailure: health.lastFailure ?? health.lastFailureMessage, deadLetterReasons: deadReasons, transportTail } }
  }
  const requests = existsSync(user.env.FAKE_LOG) ? readFileSync(user.env.FAKE_LOG, 'utf8').split('\n').filter((l) => l.includes('"phase":"end"')).length : 0
  const total = mode === 'backlog' ? drainMs : committedMs + drainMs
  return {
    status: 'measured', mode, records: count, fakeLatencyMs: slowMs, notify: stats(commits.map((c) => c.ms)),
    commitPhaseMs: Math.round(committedMs), drainAfterLastCommitMs: Math.round(drainMs),
    recordsPerSecond: Math.round((count / (total / 1000)) * 10) / 10,
    transportRequests: requests, recordsPerRequest: requests ? Math.round((count / requests) * 10) / 10 : null, deadLetters: done.deadLetterRecords,
    worker: { peakConcurrent: peakWorkers, peakRssMiB: peakRss || null, peakPcpu: peakCpu || null, psSamples: samples }
  }
}

async function uploaderPhase(uploader, report) {
  const protocol = JSON.parse(readFileSync(join(here, 'protocol.json'), 'utf8'))
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
        : `  uploader ${key}: unavailable (${result.reason}; lastError ${JSON.stringify(result.diagnostics?.lastError ?? null)})\n`)
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
  const cell = (m) => m?.status === 'measured' ? `${m.p50} / ${m.p95}` : `unavailable${m?.reason ? `（${m.reason}）` : ''}`
  if (report.recorder?.status === 'unavailable') lines.push('## Recorder hook 路径', '', `unavailable：${report.recorder.reason}`, '')
  if (report.recorder?.modes) {
    lines.push('## Recorder hook 路径（毫秒，p50 / p95）', '', `Provider 形状：${report.recorder.provider}；${report.recorder.note}；每格 ${ROUNDS} 轮。`, '')
    for (const [mode, scenarios] of Object.entries(report.recorder.modes)) {
      lines.push(`### ${mode}`, '', '| 场景 | 轮次开始 | 单个工具事件 | 轮次结束 | 每轮 hook 合计 | 结束到记录落盘 |', '| --- | --- | --- | --- | --- | --- |')
      for (const [name, m] of Object.entries(scenarios)) lines.push(`| ${name} | ${cell(m.turnStart)} | ${cell(m.toolEvent)} | ${cell(m.stop)} | ${cell(m.hookTotalPerTurn)} | ${cell(m.stopToRecordVisible)} |`)
      lines.push('')
    }
    lines.push('```json', JSON.stringify({ daemon: report.recorder.daemon, disk: report.recorder.disk, hookSkips: report.recorder.hookSkips, verify: report.recorder.verify }, null, 2), '```', '')
  }
  if (report.uploader?.status === 'unavailable') lines.push('## Uploader', '', `unavailable：${report.uploader.reason}（下表只含失败前完成的场景）`, '')
  if (report.uploader) {
    lines.push('## Uploader（假传输层，不联网）', '', `载荷：${report.uploader.payload}`, '', `hook 路径 notify（上传进行中）：${cell(report.uploader.notifyWhileUploading)} ms`, '',
      'streaming：记录逐条到达、边提交边上传；backlog：先积压（不拉起 worker），再一次唤醒排空。', '',
      '| 场景 | notify p50 / p95 | 提交阶段 | 最后一条提交后排空 | 条/秒 | 请求数（条/请求） | worker 峰值数 | worker 峰值 RSS | upload 目录 KiB/条 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const [name, m] of Object.entries(report.uploader.runs ?? {})) {
      if (m.status !== 'measured') { lines.push(`| ${name} | unavailable（${m.reason}${m.diagnostics ? `；${JSON.stringify(m.diagnostics).replaceAll('|', '\\|')}` : ''}） | | | | | | | |`); continue }
      lines.push(`| ${name} | ${cell(m.notify)} | ${m.commitPhaseMs} ms | ${m.drainAfterLastCommitMs} ms | ${m.recordsPerSecond} | ${m.transportRequests}（${m.recordsPerRequest}） | ${m.worker.peakConcurrent} | ${m.worker.peakRssMiB ? `${m.worker.peakRssMiB} MiB` : 'unavailable（采样时没有 worker）'} | ${m.uploadDirKiBPerRecord} |`)
    }
    lines.push('')
  }
  lines.push('## 说明', '', '- 毫秒值是本机在记录的负载下的墙钟时间，只和同一台机器上的后续结果比较。', '- 这是受控测量（L2），不是日常使用下的结论；不写入 `scripts/performance-ratchet.json`。', '- `unavailable` 表示没测到，原因写在旁边，不等于 0。', '')
  return lines.join('\n')
}

async function baseline() {
  const scry = opt('scry') && resolve(opt('scry'))
  const uploader = opt('uploader') && resolve(opt('uploader'))
  const only = opt('only')
  const report = { environment: environment(), versions: {}, rounds: ROUNDS }
  if (only !== 'uploader') {
    if (!opt('source') || !opt('work') || !scry) throw new Error('recorder phase needs --source, --work and --scry')
    const work = prepareCopy(opt('source'), opt('work'))
    report.versions.scry = tryRun(process.execPath, [scry, 'version'])
    report.repository = { name: basename(realpathSync(opt('source'))), copy: work, copyInfo: JSON.parse(readFileSync(join(work, MARKER), 'utf8')), ...repoStats(work) }
    console.log(`recorder phase on ${work} (${report.repository.tracked} tracked files)`)
    try { await recorderPhase(scry, work, report) } catch (error) {
      report.recorder = unavailable(`recorder phase failed: ${error.message}`)
      console.error(`recorder phase failed: ${error.message}`)
    }
  }
  if (only !== 'recorder') {
    if (!uploader) throw new Error('uploader phase needs --uploader')
    console.log('uploader phase (fake transport)')
    try { await uploaderPhase(uploader, report) } catch (error) {
      report.uploader = { ...(report.uploader ?? {}), status: 'unavailable', reason: `uploader phase failed: ${error.message}` }
      console.error(`uploader phase failed: ${error.message}`)
    }
    report.versions.uploader = report.uploader?.version ?? tryRun(process.execPath, [uploader, 'version'])
  }
  report.environment.loadAverageAtEnd = load()
  const stamp = report.environment.at.replace(/[:.]/g, '-')
  const jsonPath = join(outDir, `baseline-${stamp}.json`)
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(outDir, `baseline-${stamp}.md`), markdown(report))
  console.log(`written: ${jsonPath}\nwritten: ${jsonPath.replace(/\.json$/, '.md')}`)
}

try {
  if (sub === 'e2e') await e2e()
  else await baseline()
} catch (error) {
  console.error(`perf-bench: ${error.message}`)
  process.exit(1)
}
