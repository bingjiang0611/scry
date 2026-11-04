import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_PATH, ROUNDS, here, now, opt, sleep } from './bench-args.mjs'
import { cloneTree } from './bench-copy.mjs'
import { environment, hook, load, run, stats, tryRun, turn, unavailable } from './bench-util.mjs'

// ---------- uploader (fake transport, temp HOME) ----------
function uploaderUser(protocol, root) {
  for (const d of ['home', 'state', 'config']) mkdirSync(join(root, d), { recursive: true })
  const control = join(root, 'control.json')
  writeFileSync(control, '{}')
  // The recorder pins a fixed environment allowlist when it runs the commit hook, so FAKE_* never
  // reach the uploader worker. Point the transport variable at a self-contained launcher instead,
  // otherwise the worker's transport falls back to the public protocol and every upload fails.
  const log = join(root, 'transport.log')
  const transport = join(root, 'fake-transport')
  writeFileSync(transport, [
    '#!/bin/sh',
    `FAKE_PROTOCOL='${PROTOCOL_PATH}'`,
    `FAKE_CONTROL='${control}'`,
    `FAKE_LOG='${log}'`,
    'export FAKE_PROTOCOL FAKE_CONTROL FAKE_LOG',
    `exec '${process.execPath}' '${join(here, 'fake-transport.mjs')}' "$@"`,
    ''
  ].join('\n'), { mode: 0o755 })
  const env = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || tmpdir(), LANG: process.env.LANG || 'en_US.UTF-8',
    HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'),
    [protocol.transportEnv]: transport, SCRY_CLI_PATH: join(here, 'fake-scry.mjs'),
    FAKE_CONTROL: control, FAKE_LOG: log, FAKE_PROTOCOL: PROTOCOL_PATH
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
      // The variable name is the one real protocol value that reaches a report; keep it out of the
      // pushed results and say only that the transport was confirmed.
      u.fakeTransport = 'confirmed'
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

export { uploaderUser, uploaderWorkspace, commit, upStatus, uploaderProcesses, drain, uploaderPhase }
