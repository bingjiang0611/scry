import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_PATH, ROUNDS, here, now, opt, sleep } from './bench-args.mjs'
import { forceRemove, prepareCopy, worktreeState } from './bench-copy.mjs'
import { countGitCalls } from './bench-gitcalls.mjs'
import { commit, uploaderUser, uploaderWorkspace } from './bench-uploader.mjs'
import { environment, hook, node, recordCount, run, skipCount, stats, tryRun, turn, unavailable } from './bench-util.mjs'

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

// Read-only entries inside a Provider config dir (cached bundles and similar) make `rmSync` fail
// with EACCES; a half-finished delete here would leave the copy short of tracked files and poison
// every later measurement in the session, so make the tree writable first.
function restoreAside(work, saved, { moved, copied }) {
  for (const entry of ['.scry', 'scry.config.json', ...PROVIDER_CONFIG_DIRS]) forceRemove(join(work, entry))
  for (const entry of moved) renameSync(join(saved, entry), join(work, entry))
  for (const entry of copied) cpSync(join(saved, 'copies', entry), join(work, entry), { recursive: true, verbatimSymlinks: true })
  forceRemove(saved)
}

// The phase moves Provider config dirs aside and back; if the restore misses anything the copy no
// longer matches the workload, so compare the worktree state around the phase instead of trusting it.
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
  const stateBefore = worktreeState(work)
  const moved = setAside(work, saved)
  h.copySetAside = moved
  let phaseError
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
  } catch (error) {
    phaseError = error
    throw error
  } finally {
    stopRecorder()
    killWorkers()
    restoreAside(work, saved, moved)
    const stateAfter = worktreeState(work)
    if (stateBefore !== undefined && stateAfter !== stateBefore) {
      const message = 'hookwrap left the copy different from how it found it; later measurements on this copy cannot be trusted'
      h.restoreMismatch = { before: stateBefore.length, after: stateAfter?.length }
      if (phaseError) console.error(`perf-bench: ${message} (the phase also failed: ${phaseError.message})`)
      else throw new Error(message)
    }
    try { forceRemove(root) } catch (error) {
      h.leftover = { path: root, reason: String(error.message).slice(0, 200) }
    }
  }
}

export { HOOKWRAP_SCENARIOS, HOOKWRAP_FIELDS, COUNT_FIELDS, PROVIDER_CONFIG_DIRS, measureTurns, setAside, restoreAside, hookwrapPhase }
