#!/usr/bin/env node
// Black-box rollout checks for the Scry uploader.
//
// Everything runs under a fresh temporary directory: its own HOME, XDG_STATE_HOME,
// XDG_CONFIG_HOME, workspaces and a fake transport. Nothing touches your real
// workspaces, launchd services, credentials or the real upload service.
//
// Usage:
//   node run.mjs --uploader /path/to/uploader/dist/cli.js [--only S01,S04] [--keep] [--report out.json]
//   (--uploader also accepts an executable on PATH, e.g. --uploader scry-upload)
//   S19 (upgrade/rollback) runs only with --old-uploader /path/to/older/dist/cli.js
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const flag = name => argv.includes(`--${name}`)
const uploader = opt('uploader') || 'scry-upload'
const oldUploader = opt('old-uploader')
const only = opt('only')?.split(',').map(s => s.trim().toUpperCase())
const protocolPath = opt('protocol') || join(here, 'protocol.json')
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-rollout-')))
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (const f of ['fake-transport.mjs', 'fake-scry.mjs']) chmodSync(join(here, f), 0o755)

// ---------- environment ----------
function makeUser(name) {
  const dir = join(root, name)
  for (const d of ['home', 'state', 'config']) mkdirSync(join(dir, d), { recursive: true })
  const control = join(dir, 'control.json')
  writeFileSync(control, '{}')
  const env = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || tmpdir(), LANG: process.env.LANG || 'en_US.UTF-8',
    HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state'), XDG_CONFIG_HOME: join(dir, 'config'),
    [protocol.transportEnv]: join(here, 'fake-transport.mjs'),
    SCRY_CLI_PATH: join(here, 'fake-scry.mjs'),
    FAKE_CONTROL: control, FAKE_LOG: join(dir, 'transport.log'), FAKE_PROTOCOL: protocolPath
  }
  return { dir, env, control: value => writeFileSync(control, JSON.stringify(value)) }
}

function cli(user, args, { input, env = {}, allowFail = false, bin = uploader } = {}) {
  const [cmd, pre] = /\.(m?js|cjs)$/.test(bin) ? [process.execPath, [bin]] : [bin, []]
  try {
    return execFileSync(cmd, [...pre, ...args], { env: { ...user.env, ...env }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 })
  } catch (error) {
    if (allowFail) return `${error.stdout ?? ''}${error.stderr ?? ''}`
    throw new Error(`uploader ${args.join(' ')} failed: ${(error.stderr || error.message).slice(0, 600)}`)
  }
}

function makeWorkspace(user, name, { dataDir } = {}) {
  const ws = join(user.dir, name)
  mkdirSync(ws, { recursive: true })
  try { execFileSync('git', ['init', '-q', ws]) } catch {}
  writeFileSync(join(ws, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: `ws-${name}`, ...(dataDir ? { dataDir } : {}) }))
  const data = join(ws, dataDir || '.scry')
  mkdirSync(join(data, 'records'), { recursive: true })
  return { ws: realpathSync(ws), data, seq: 0, name }
}

// Same path a provider hook takes: canonical record on disk, then `notify` on stdin.
function commit(user, w, { env, bin } = {}) {
  const sequence = ++w.seq
  const recordId = randomBytes(16).toString('hex')
  const raw = JSON.stringify({ schemaVersion: 1, sequence, recordId, workspace: { id: `ws-${w.name}`, root: w.ws },
    provider: 'claude', sessionId: 'rollout-session', prompt: 'rollout check', pad: 'x'.repeat(400) }, null, 2) + '\n'
  const name = `${String(sequence).padStart(20, '0')}-${recordId}.json`
  writeFileSync(join(w.data, 'records', name), raw)
  const event = { schemaVersion: 2, event: 'record-committed', workspace: w.ws, provider: 'claude', sessionId: 'rollout-session',
    sequence, recordId, recordPath: `records/${name}`, sha256: createHash('sha256').update(raw).digest('hex') }
  cli(user, ['notify', '--workspace', w.ws], { input: JSON.stringify(event), env, bin })
  return recordId
}

const status = (user, w, bin) => JSON.parse(cli(user, ['status', '--workspace', w.ws, '--json'], { bin }))
const kick = (user, w, env) => cli(user, ['wakeup', '--workspace', w.ws], { env })
function calls(user) {
  if (!existsSync(user.env.FAKE_LOG)) return []
  return readFileSync(user.env.FAKE_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}
const ends = user => calls(user).filter(c => c.phase === 'end')
const uploadedIds = user => new Set(ends(user).filter(c => /inserted|duplicated/.test(c.result)).flatMap(c => c.ids))
function maxConcurrency(user) {
  let live = 0, max = 0
  const ev = calls(user).map(c => [c.t, c.phase === 'start' ? 1 : -1]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  for (const [, d] of ev) { live += d; max = Math.max(max, live) }
  return max
}
function workerPids(w) {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return out.split('\n').filter(l => l.includes('_worker') && l.includes(w.ws)).map(l => Number(l.trim().split(/\s+/)[0]))
}
function killWorkers(w) { for (const pid of workerPids(w)) { try { process.kill(pid, 'SIGKILL') } catch {} } }
async function waitFor(fn, ms, every = 1000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return null
    await sleep(every)
  }
}
const drained = (user, w) => waitFor(() => { const s = status(user, w); return s.outboxPending === 0 && s.committedPending === 0 ? s : null }, 0)
function filesUnder(dir) {
  const out = []
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else if (st.size < 4_000_000) out.push(p) } }
  if (existsSync(dir)) walk(dir)
  return out
}

// ---------- scenarios ----------
const scenarios = {
  async S01(u) {
    const w = makeWorkspace(u, 'repo')
    const ids = Array.from({ length: 5 }, () => commit(u, w))
    const ok = await waitFor(() => ids.every(id => uploadedIds(u).has(id)) && drained(u, w), 60_000)
    const s = status(u, w)
    return ok && s.deadLetterRecords === 0 ? pass(`5/5 uploaded, ${ends(u).length} requests`) : fail(`uploaded ${ids.filter(id => uploadedIds(u).has(id)).length}/5`, s)
  },
  async S02(u) {
    u.control({ mode: 'outage503' })
    const w = makeWorkspace(u, 'repo')
    const ids = Array.from({ length: 10 }, () => commit(u, w))
    await sleep(25_000)
    const during = ends(u).length
    u.control({ mode: 'ok' }); kick(u, w)
    const ok = await waitFor(() => ids.every(id => uploadedIds(u).has(id)) && drained(u, w), 180_000, 2000)
    const s = status(u, w)
    if (!ok) return fail('not drained after recovery', s)
    if (s.deadLetterRecords) return fail(`${s.deadLetterRecords} dead letters after a pure outage`, s)
    return during <= 15 ? pass(`${during} requests in 25s outage, all 10 uploaded after recovery`) : fail(`${during} requests in 25s outage (breaker too weak)`)
  },
  async S03(u) {
    u.control({ mode: 'busy' })
    const w = makeWorkspace(u, 'repo')
    const ids = Array.from({ length: 10 }, () => commit(u, w))
    await sleep(40_000)
    const deadDuring = status(u, w).deadLetterRecords
    u.control({ mode: 'ok' }); kick(u, w)
    const ok = await waitFor(() => ids.every(id => uploadedIds(u).has(id)) && drained(u, w), 180_000, 2000)
    if (deadDuring) return fail(`${deadDuring} intact records dead-lettered during an unrecognised outage`)
    return ok ? pass('0 dead letters during outage, all uploaded after recovery') : fail('not drained after recovery', status(u, w))
  },
  async S04(u) {
    const w = makeWorkspace(u, 'repo')
    const first = commit(u, w)
    u.control({ failRecordIds: [first], failKind: '413' })
    const rest = Array.from({ length: 9 }, () => commit(u, w))
    const ok = await waitFor(() => rest.every(id => uploadedIds(u).has(id)), 120_000, 2000)
    return ok ? pass(`poison isolated; 9/9 others uploaded (poison ${status(u, w).deadLetterRecords ? 'dead-lettered' : 'deferred'})`)
      : fail(`others uploaded ${rest.filter(id => uploadedIds(u).has(id)).length}/9 (head-of-line blocking)`)
  },
  async S05(u) {
    const w = makeWorkspace(u, 'repo')
    const first = commit(u, w)
    u.control({ failRecordIds: [first], failKind: 'business' })
    const rest = Array.from({ length: 9 }, () => commit(u, w))
    const ok = await waitFor(() => rest.every(id => uploadedIds(u).has(id)), 150_000, 2000)
    return ok ? pass('business-error poison isolated; 9/9 others uploaded') : fail(`others uploaded ${rest.filter(id => uploadedIds(u).has(id)).length}/9`)
  },
  async S06(u) {
    u.control({ mode: 'timeout' })
    const w = makeWorkspace(u, 'repo')
    const ids = Array.from({ length: 5 }, () => commit(u, w))
    await sleep(15_000)
    u.control({ mode: 'ok' })
    // Timeout backoff starts at about 60s, so recovery is expected to take a few minutes.
    const ok = await waitFor(() => { kick(u, w); return ids.every(id => uploadedIds(u).has(id)) && drained(u, w) }, 300_000, 10_000)
    const s = status(u, w)
    return ok && !s.deadLetterRecords ? pass('timeouts deferred, all uploaded after recovery, 0 dead letters') : fail('not recovered from timeouts', s)
  },
  async S07(u) {
    u.control({ mode: 'lostResponse' })
    const w = makeWorkspace(u, 'repo')
    const ids = Array.from({ length: 3 }, () => commit(u, w))
    const ok = await waitFor(() => { const s = status(u, w); return s.outboxPending === 0 && s.committedPending === 0 }, 120_000, 2000)
    const dup = ends(u).filter(c => c.result.includes('duplicated')).flatMap(c => c.ids)
    return ok && ids.every(id => dup.includes(id)) ? pass('lost responses retried with same identity, accepted as duplicated') : fail('lost-response records not settled', status(u, w))
  },
  async S08(u) {
    u.control({ mode: 'malformed' })
    const w = makeWorkspace(u, 'repo')
    commit(u, w)
    await sleep(60_000)
    const n = ends(u).length
    u.control({ mode: 'ok' })
    return n <= 12 ? pass(`${n} requests in 60s of malformed responses (backs off, no hot loop)`) : fail(`${n} requests in 60s (hot loop)`)
  },
  async S09(u) {
    u.control({ slowMs: 6000 })
    const w = makeWorkspace(u, 'repo')
    commit(u, w)
    await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise(r => {
      const [cmd, pre] = /\.(m?js|cjs)$/.test(uploader) ? [process.execPath, [uploader]] : [uploader, []]
      spawn(cmd, [...pre, 'wakeup', '--workspace', w.ws], { env: { ...u.env, SCRY_UPLOAD_TRIGGER: 'completion', SCRY_UPLOAD_SESSION_ID: `burst-${i}` }, stdio: 'ignore' }).on('close', r)
    })))
    await sleep(3000)
    const workers = workerPids(w).length
    u.control({})
    return workers <= 2 ? pass(`${workers} worker process(es) after 20 hook calls`) : fail(`${workers} worker processes after 20 hook calls (pile-up)`)
  },
  async S10(u) {
    u.control({ slowMs: 1500 })
    const repos = Array.from({ length: 5 }, (_, i) => makeWorkspace(u, `repo${i}`))
    const ids = repos.flatMap(w => Array.from({ length: 8 }, () => commit(u, w)))
    const ok = await waitFor(() => ids.every(id => uploadedIds(u).has(id)), 300_000, 3000)
    const conc = maxConcurrency(u)
    const dead = repos.reduce((n, w) => n + status(u, w).deadLetterRecords, 0)
    if (!ok) return fail(`uploaded ${ids.filter(id => uploadedIds(u).has(id)).length}/40 across 5 repos`)
    return conc <= 2 && !dead ? pass(`40/40 across 5 repos, max ${conc} concurrent uploads`) : fail(`max concurrency ${conc}, dead letters ${dead}`)
  },
  async S11(u) {
    const w = makeWorkspace(u, 'repo')
    cli(u, ['disable', '--workspace', w.ws])
    const held = [commit(u, w), commit(u, w)]
    await sleep(8000)
    const s1 = status(u, w)
    if (held.some(id => uploadedIds(u).has(id))) return fail('records committed while disabled were uploaded')
    cli(u, ['enable', '--workspace', w.ws])
    const fresh = commit(u, w)
    const ok = await waitFor(() => uploadedIds(u).has(fresh), 60_000)
    if (!ok) return fail('record after enable was not uploaded', status(u, w))
    if (held.some(id => uploadedIds(u).has(id))) return fail('enable silently uploaded records from the disabled period')
    cli(u, ['flush', '--workspace', w.ws, '--release-disabled', held[0]]); kick(u, w)
    const released = await waitFor(() => uploadedIds(u).has(held[0]), 60_000)
    return released && !uploadedIds(u).has(held[1]) ? pass(`held while disabled (disabledHeld=${s1.disabledHeld}), new record uploads after enable, explicit release uploads only that record`)
      : fail('explicit release did not upload exactly one held record')
  },
  async S12(u) {
    const w = makeWorkspace(u, 'repo')
    const id = commit(u, w)
    u.control({ rejectRecordIds: [id] })
    const dead = await waitFor(() => status(u, w).deadLetterRecords === 1, 60_000)
    if (!dead) return fail('rejected record did not reach the dead-letter queue', status(u, w))
    u.control({})
    cli(u, ['redrive', '--workspace', w.ws, '--record-id', id, '--reason', 'rollout-check'])
    const ok = await waitFor(() => uploadedIds(u).has(id) && status(u, w).deadLetterRecords === 0, 60_000)
    return ok ? pass('rejected -> dead letter -> redrive -> uploaded') : fail('redriven record not uploaded', status(u, w))
  },
  async S13(u) {
    const w = makeWorkspace(u, 'repo', { dataDir: 'var/scry data' })
    const ids = Array.from({ length: 3 }, () => commit(u, w))
    const ok = await waitFor(() => ids.every(id => uploadedIds(u).has(id)), 60_000)
    const stray = existsSync(join(w.ws, '.scry', 'upload'))
    return ok && !stray ? pass('custom dataDir (with a space) uploads, nothing written under .scry/upload') : fail(ok ? 'state leaked into .scry/upload' : 'custom dataDir records not uploaded')
  },
  async S14(u) {
    u.control({ slowMs: 8000 })
    const w = makeWorkspace(u, 'repo')
    const ids = Array.from({ length: 3 }, () => commit(u, w))
    await waitFor(() => calls(u).some(c => c.phase === 'start'), 30_000, 500)
    killWorkers(w)
    u.control({})
    await sleep(1000); kick(u, w)
    const ok = await waitFor(() => ids.every(id => uploadedIds(u).has(id)) && drained(u, w), 120_000, 2000)
    return ok ? pass('worker killed mid-upload; all records uploaded after the next wakeup') : fail('records lost or stuck after worker crash', status(u, w))
  },
  async S15(u) {
    const secrets = { bearer: 'SECRETBEARER123', cookieA: 'SECRETCOOKIEA', cookieB: 'SECRETCOOKIEB', spaced: 'horse battery staple' }
    const stderrSecret = `Authorization: Bearer ${secrets.bearer}\nCookie: a=${secrets.cookieA}; b=${secrets.cookieB}\n{"password": "correct ${secrets.spaced}"}`
    u.control({ mode: 'outage503', stderrSecret })
    const w = makeWorkspace(u, 'repo')
    commit(u, w)
    await sleep(10_000)
    // Upload failures keep transport stderr out of state files; `doctor` prints a
    // failing identity probe's diagnostic, so check that surface too.
    u.control({ mode: 'outage503', stderrSecret, authProbeFails: true })
    const out = cli(u, ['flush', '--workspace', w.ws], { allowFail: true }) + '\n' + cli(u, ['doctor', '--workspace', w.ws, '--json'], { allowFail: true })
    u.control({})
    const haystack = [out, ...filesUnder(w.ws).map(p => readFileSync(p, 'utf8')), ...filesUnder(u.env.XDG_STATE_HOME).map(p => readFileSync(p, 'utf8'))].join('\n')
    const leaked = Object.entries(secrets).filter(([, v]) => haystack.includes(v)).map(([k]) => k)
    if (leaked.includes('bearer') || leaked.includes('cookieA')) return fail(`credential written to disk/output: ${leaked.join(', ')}`)
    if (leaked.length) return known(`known redaction gap: ${leaked.join(', ')} survived`)
    return pass('no credential from transport stderr found in state files, flush or doctor output')
  },
  async S17(u) {
    // launchd substitute: no hook ever fires again after the outage; only the
    // periodic `_recover` entry (what launchd runs every 60s) may drain the backlog.
    u.control({ mode: 'outage503' })
    const repos = [makeWorkspace(u, 'repoA'), makeWorkspace(u, 'repoB')]
    for (const w of repos) cli(u, ['register', '--workspace', w.ws])
    const ids = repos.flatMap(w => Array.from({ length: 4 }, () => commit(u, w)))
    await sleep(8000)
    for (const w of repos) killWorkers(w)
    u.control({ mode: 'ok' })
    const ok = await waitFor(() => {
      cli(u, ['_recover'], { allowFail: true, env: { SCRY_UPLOADER_NO_SPAWN: '1' } })
      return ids.every(id => uploadedIds(u).has(id))
    }, 240_000, 5000)
    return ok ? pass('backlog in 2 registered repos drained by _recover alone (no hooks, workers killed)')
      : fail(`uploaded ${ids.filter(id => uploadedIds(u).has(id)).length}/8 via _recover`)
  },
  async S18(u) {
    // Hook-path latency: `notify` runs inside the provider's commit hook.
    const w = makeWorkspace(u, 'repo')
    const times = []
    for (let i = 0; i < 20; i++) { const t = Date.now(); commit(u, w); times.push(Date.now() - t) }
    times.sort((a, b) => a - b)
    const p50 = times[10], p95 = times[18]
    return p95 <= 1500 ? pass(`notify p50 ${p50}ms, p95 ${p95}ms over 20 commits`) : fail(`notify p95 ${p95}ms (p50 ${p50}ms) blocks the agent`)
  },
  // Upgrade with a backlog, then a rollback probe: no record may be lost, the
  // new version must drain everything the old one queued.
  async S19(u) {
    if (!oldUploader) return { result: 'SKIP', detail: 'pass --old-uploader <older dist/cli.js> to run' }
    u.control({ mode: 'outage503' })
    const w = makeWorkspace(u, 'repo')
    const ids = Array.from({ length: 4 }, () => commit(u, w, { bin: oldUploader }))
    await sleep(6000)
    killWorkers(w)
    const before = status(u, w, oldUploader)
    if ((before.outboxPending ?? 0) + (before.committedPending ?? 0) === 0) return fail('backlog was not established under the old version', before)
    let note = ''
    let after
    try { after = status(u, w) } catch (error) {
      if (!/legacy_store_requires_migration/.test(String(error.message))) throw error
      cli(u, ['migrate', '--workspace', w.ws])
      note = ' (needed migrate)'
      after = status(u, w)
    }
    const keys = ['outboxPending', 'committedPending', 'deadLetterRecords', 'disabledHeld']
    const changed = keys.filter(k => (before[k] ?? 0) !== (after[k] ?? 0))
    if (changed.length) return fail(`upgrade changed ${changed.join(', ')}: ${JSON.stringify(Object.fromEntries(changed.map(k => [k, [before[k], after[k]]])))}`)
    // Rollback probe: the old CLI must either read the store or refuse explicitly; it must not corrupt it.
    const rollback = cli(u, ['status', '--workspace', w.ws, '--json'], { bin: oldUploader, allowFail: true })
    u.control({ mode: 'ok' }); kick(u, w)
    const ok = await waitFor(() => ids.every(id => uploadedIds(u).has(id)) && drained(u, w), 180_000, 2000)
    if (!ok) return fail(`new version did not drain the upgraded backlog${note}`, status(u, w))
    const rollbackNote = /^\s*\{/.test(rollback) ? 'old CLI still reads the store' : `old CLI refuses: ${rollback.trim().slice(0, 120)}`
    return pass(`backlog ${before.outboxPending}+${before.committedPending} unchanged across upgrade${note}; 4/4 uploaded by new version; ${rollbackNote}`)
  },
  async S20(u) {
    u.control({ loggedOut: true })
    const w = makeWorkspace(u, 'repo')
    const ids = Array.from({ length: 2 }, () => commit(u, w))
    await sleep(8000)
    for (let i = 0; i < 3; i++) { kick(u, w); await sleep(1000) }
    const s = status(u, w)
    const denied = calls(u).filter(c => c.phase === 'denied').length
    const health = JSON.parse(readFileSync(join(w.data, 'upload', 'health.json'), 'utf8'))
    if (s.deadLetterRecords) return fail('expired login sent records to dead letter', s)
    if ((s.outboxPending ?? 0) + (s.committedPending ?? 0) < 2) return fail('records left the local queue while logged out', s)
    const authVisible = /auth|login|登录/i.test(JSON.stringify({ lastError: s.lastError, health }))
    if (!authVisible) return fail('status/health does not say the login expired', { lastError: s.lastError, health: health.status })
    u.control({})
    cli(u, ['flush', '--workspace', w.ws], { allowFail: true })
    const ok = await waitFor(() => ids.every(id => uploadedIds(u).has(id)) && drained(u, w), 60_000, 2000)
    if (!ok) return fail('manual flush after re-login did not upload', status(u, w))
    return pass(`kept 2 records locally, ${denied} denied calls while logged out (3 extra wakeups), health ${health.status}; flush after re-login uploaded 2/2`)
  },
  async S16(u) {
    u.control({ slowMs: 5000 })
    const w = makeWorkspace(u, 'repo')
    commit(u, w); commit(u, w)
    await waitFor(() => calls(u).some(c => c.phase === 'start'), 30_000, 500)
    rmSync(w.ws, { recursive: true, force: true })
    u.control({})
    await sleep(12_000)
    const recreated = existsSync(w.ws)
    const workers = workerPids(w).length
    return !recreated && workers === 0 ? pass('deleted workspace stays deleted; worker exited') : fail(`recreated=${recreated} workers=${workers}`)
  }
}
const titles = {
  S01: 'Happy path: 5 records upload', S02: 'HTTP 503 outage then recovery', S03: 'Unrecognised outage ("busy") then recovery',
  S04: 'Poison record (413) does not block others', S05: 'Poison record (business error, no status)', S06: 'Transport timeouts then recovery',
  S07: 'Lost response -> duplicated accepted', S08: 'Malformed response backs off', S09: 'Hook burst does not pile up workers',
  S10: 'Multi-repo: 5 repos x 8 records, concurrency cap', S11: 'Disable / enable / explicit release', S12: 'Dead letter and redrive',
  S13: 'Custom dataDir with a space', S14: 'Worker killed mid-upload', S15: 'Credentials in transport stderr', S16: 'Workspace deleted mid-upload',
  S17: 'Scheduled recovery alone drains a backlog', S18: 'Hook-path (notify) latency', S19: 'Upgrade with backlog, rollback probe', S20: 'Expired login keeps records, flush after re-login'
}
function pass(detail) { return { result: 'PASS', detail } }
function fail(detail, s) { return { result: 'FAIL', detail: s ? `${detail} | status=${JSON.stringify(s)}` : detail } }
function known(detail) { return { result: 'KNOWN', detail } }

// ---------- main ----------
console.log(`uploader: ${uploader}\nversion: ${cli(makeUser('probe'), ['version']).trim()}\ntemp root: ${root}\n`)
const results = []
for (const id of Object.keys(scenarios).sort()) {
  if (only && !only.includes(id)) continue
  const user = makeUser(id)
  const started = Date.now()
  process.stdout.write(`${id} ${titles[id]} ... `)
  let r
  try { r = await scenarios[id](user) } catch (error) { r = { result: 'ERROR', detail: String(error.message || error).slice(0, 800) } }
  for (const d of readdirSync(user.dir)) { const p = join(user.dir, d); if (existsSync(join(p, 'scry.config.json'))) killWorkers({ ws: realpathSync(p) }) }
  r = { id, title: titles[id], seconds: Math.round((Date.now() - started) / 1000), ...r }
  results.push(r)
  console.log(`${r.result} (${r.seconds}s) ${r.detail}`)
}
const summary = results.reduce((m, r) => ({ ...m, [r.result]: (m[r.result] || 0) + 1 }), {})
console.log(`\nsummary: ${JSON.stringify(summary)}`)
const reportPath = opt('report') || join(process.cwd(), `rollout-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(reportPath, JSON.stringify({ uploader, at: new Date().toISOString(), protocol: relative(process.cwd(), protocolPath), results }, null, 2))
console.log(`report: ${reportPath}`)
if (!flag('keep')) rmSync(root, { recursive: true, force: true })
process.exit(results.some(r => r.result === 'FAIL' || r.result === 'ERROR') ? 1 : 0)
