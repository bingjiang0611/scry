// B4-V「升级」: a daemon from an older build is running when a newer App starts. The App
// must fail hard with daemon_version_mismatch and must not replace the daemon behind the
// user's back; the user's「重启后台服务」then makes it usable again.
//
// The old daemon is started directly (no supervisor), the way an older build's daemon
// would already be running. By default it is this build's daemon entry announcing an
// older version; `--old-daemon-entry <path to an older out/main/daemon.js>` uses a real
// older build instead. The report says which one ran.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { API_TREE_EXPRESSION, callExpression, findAction, functionPaths } from '../api-detect.mjs'
import { attempt, electronExecutable, until } from '../app.mjs'
import { daemonHolder, daemonLogPath, fixtureDaemonProcesses, own, waitForDaemonHolder } from '../fixture.mjs'
import { Abort, openChecked, runScenario, waitForLiveIsolation } from '../kit.mjs'
import { readIdentity } from '../process-identity.mjs'
import { recordNotRun, recordStep } from '../report.mjs'

export const OLD_VERSION = '0.0.0-b4v-old'

export const plan = [
  { id: 'old-daemon-running', expected: 'an older daemon (another version) holds daemon.lock in the temp userData and listens on local.sock' },
  { id: 'app-hard-failure', expected: 'the new App reports daemon_version_mismatch on its first run call (within 60 s) instead of working or hanging' },
  { id: 'no-silent-replacement', expected: 'the old daemon is still the verified lock holder and the only daemon for this state directory' },
  { id: 'restart-action-present', expected: 'S0-1: a「重启后台服务」action is reachable from the window (window.scry)' },
  { id: 'recovered-after-restart', expected: 'after the restart action, a daemon of this build holds the lock (new identity) and run calls succeed' }
]

// Only what the daemon needs; HOME is the fixture's, never the user's.
export function oldDaemonEnv({ root, fixture, version, base = process.env }) {
  const pass = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL'].filter((key) => base[key] !== undefined).map((key) => [key, base[key]]))
  return {
    ...pass,
    HOME: fixture.home,
    ELECTRON_RUN_AS_NODE: '1',
    SCRY_DAEMON_STATE_DIR: fixture.daemonState,
    SCRY_DAEMON_USER_DATA_DIR: fixture.userDataDir,
    SCRY_DAEMON_APP_PATH: root,
    SCRY_DAEMON_RESOURCES_PATH: join(root, 'resources'),
    SCRY_DAEMON_APP_VERSION: version,
    SCRY_DAEMON_PACKAGED: '0',
    SCRY_DAEMON_STARTED_BY: 'b4v-old-build',
    SCRY_DAEMON_SMOKE_PROVIDER: '1',
    SCRY_REMOTE_HOST: '0',
    SCRY_REMOTE_RELAY_ENABLED: '0'
  }
}

export async function run(ctx) {
  return runScenario(ctx, { id: 'upgrade', title: '升级：旧 daemon + 新 App', mode: 'daemon', label: 'upgrade', plan }, async ({ scenario, fixture }) => {
    const entry = resolve(ctx.options.oldDaemonEntry ?? join(ctx.root, 'out', 'main', 'daemon.js'))
    if (!existsSync(entry)) throw new Abort(`old daemon entry missing: ${entry}`)
    // <checkout>/out/main/daemon.js: the older checkout is its own app path and, when it
    // has one, its own Electron. Dev builds share one package version, so the older build
    // still announces OLD_VERSION explicitly; otherwise it would not look older at all.
    const appRoot = resolve(entry, '..', '..', '..')
    const executable = existsSync(electronExecutable(appRoot)) ? electronExecutable(appRoot) : electronExecutable(ctx.root)
    scenario.evidence.oldDaemon = { entry, appRoot, executable, version: OLD_VERSION, realOlderBuild: Boolean(ctx.options.oldDaemonEntry) }
    mkdirSync(join(fixture.userDataDir, 'logs'), { recursive: true })
    const log = openSync(daemonLogPath(fixture), 'a', 0o600)
    const child = spawn(executable, [entry], {
      env: oldDaemonEnv({ root: appRoot, fixture, version: OLD_VERSION }), stdio: ['ignore', log, log]
    })
    closeSync(log)
    child.once('error', () => undefined)
    const identity = await waitForIdentity(child.pid)
    if (identity) own(fixture, identity, 'old-daemon')
    const holder = await waitForDaemonHolder(fixture, { timeoutMs: 60_000 })
    recordStep(scenario, { id: 'old-daemon-running', actual: { pid: child.pid, verdict: holder?.verdict, holderPid: holder?.lock?.pid ?? null },
      pass: holder?.verdict === 'verified' && holder.lock.pid === child.pid })
    if (holder?.verdict !== 'verified' || holder.lock.pid !== child.pid) throw new Abort('the old daemon never held the lock')
    // Before any App exists: the old daemon must be writing the temp userData, not another.
    const live = await waitForLiveIsolation(fixture, { mode: 'daemon' })
    recordStep(scenario, { id: 'isolation-live', actual: live.checks, pass: live.ok })
    if (!live.ok) throw new Abort('live isolation failed; the App was not launched')

    // The App is opened without waiting for readiness: readiness is exactly what must fail.
    const app = await openChecked(ctx, scenario, fixture, { mode: 'daemon', label: 'new-app', isolation: false, waitReady: false })
    const failure = await until(app, 'window.scry.activeRuns().then(() => "ready", (error) => String(error && error.message || error))',
      (value) => value === 'ready' || /daemon_version_mismatch/.test(String(value)), 60_000)
    recordStep(scenario, { id: 'app-hard-failure', actual: failure, pass: failure.ok && /daemon_version_mismatch/.test(String(failure.value)) })

    const still = daemonHolder(fixture)
    const processes = fixtureDaemonProcesses(fixture)
    recordStep(scenario, { id: 'no-silent-replacement',
      actual: { verdict: still.verdict, pid: still.lock?.pid ?? null, daemons: processes.status === 'available' ? processes.daemon.map((row) => row.pid) : processes },
      pass: still.verdict === 'verified' && still.lock.identityKey === holder.lock.identityKey &&
        processes.status === 'available' && processes.daemon.length === 1 })

    const tree = await attempt(app, API_TREE_EXPRESSION)
    const action = findAction(tree.ok ? functionPaths(tree.value) : [], 'restart-daemon', ctx.options.restartApi)
    if (action.status !== 'found') {
      const reason = action.status === 'ambiguous'
        ? `several candidates (${action.candidates.join(', ')}); pass --restart-api <path> to choose`
        : 'no restart action on window.scry yet (S0-1 lane builds it)'
      recordNotRun(scenario, { id: 'restart-action-present', reason, needsProductHook: 'window.scry restart-daemon action (S0-1)' })
      recordNotRun(scenario, { id: 'recovered-after-restart', reason: 'restart action absent' })
      return
    }
    recordStep(scenario, { id: 'restart-action-present', actual: action, pass: true })
    const called = await Promise.race([attempt(app, callExpression(action.path)), new Promise((done) => setTimeout(() => done({ ok: false, error: 'call_timeout_30s (a native confirmation may be waiting)' }), 30_000))])
    const recovered = await until(app, 'window.scry.activeRuns().then(() => true, () => false)', (value) => value === true, 60_000)
    const fresh = daemonHolder(fixture)
    recordStep(scenario, { id: 'recovered-after-restart',
      actual: { called, recovered, holderPid: fresh.lock?.pid ?? null, previousPid: holder.lock.pid, oldAlive: Boolean(readIdentity(child.pid)) },
      pass: recovered.ok && fresh.verdict === 'verified' && fresh.lock.identityKey !== holder.lock.identityKey })
  })
}

async function waitForIdentity(pid) {
  for (let index = 0; index < 50; index++) {
    const identity = readIdentity(pid)
    if (identity) return identity
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  return undefined
}
