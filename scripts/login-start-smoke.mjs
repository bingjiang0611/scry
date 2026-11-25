#!/usr/bin/env node
// P5-3 login-start smoke: renders a real LaunchAgent plist / systemd unit through
// src/daemon/login-start, writes it to a temporary directory, verifies private file/log
// permissions (0700 logs dir, 0600 daemon.log & service file), parses the file back,
// launches the parsed ProgramArguments/ExecStart under a minimal service-manager
// environment (no SHELL, no inherited user env), verifies handshake + daemon self-report
// (launchedBy=service, supervisorPid, remoteConfig), and verifies SIGTERM lets the daemon
// exit cleanly before the supervisor leaves with no lock/socket leftovers.

// Usage:
//   npm run build && node scripts/login-start-smoke.mjs
//   node scripts/login-start-smoke.mjs --app dist/mac-arm64/Scry.app/Contents/MacOS/Scry
//   node scripts/login-start-smoke.mjs --app dist/linux-unpacked/scry
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { buildSync } from 'esbuild'
import { enrollLocalDevice, frame, waitForSocket } from './daemon-fixture.mjs'
import { devTarget, parseSmokeArguments, resolvePackagedApp } from './daemon-mode-smoke/packaged.mjs'

const root = process.cwd()
const options = parseSmokeArguments(process.argv.slice(2))
if (!options.ok) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: `arguments:${options.reason}` })}\n`)
  process.exit(2)
}

const target = options.app ? resolvePackagedApp(options.app) : devTarget(root)
if (!target.ok) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: `target:${target.reason}`, detail: target })}\n`)
  process.exit(2)
}
const appPath = target.packaged ? target.appArchive : target.appPath
const resourcesPath = target.packaged ? target.resources : join(root, 'resources')
const expectedVersion = target.packaged
  ? target.version
  : JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version

// Short real path under /tmp so macOS unix sockets stay within SUN_LEN.
const temp = realpathSync(mkdtempSync('/tmp/scry-login-start-smoke-'))
const homeDir = join(temp, 'home')
const userDataDir = join(temp, 'userData')
const stateDirectory = join(userDataDir, 'daemon')
const serviceDir = join(temp, 'service-dir')
mkdirSync(homeDir, { recursive: true, mode: 0o700 })
mkdirSync(userDataDir, { recursive: true, mode: 0o700 })

const bundlePath = join(temp, 'login-start-bundle.mjs')
const summary = {
  ok: false,
  target: target.packaged ? 'packaged' : 'source',
  platform: process.platform,
  steps: {}
}

let supervisor
let failure

function fail(step, detail) {
  summary.steps[step] = { ok: false, detail }
  throw new Error(`${step}: ${detail}`)
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

try {
  buildSync({
    entryPoints: [resolve('src/daemon/login-start/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundlePath
  })
  const loginStart = await import(pathToFileURL(bundlePath).href)
  const testLabel = `com.scry.daemon.smoke.${process.pid}`
  const testUnit = `scry-daemon-smoke-${process.pid}.service`

  // 1. Render & write service file via the real login-start manager (fake runner so
  //    nothing touches real launchd/systemd in the smoke test).
  const policyEnvInput = {
    SCRY_TEST_APP: '1',
    SCRY_TEST_LOGIN_START_LABEL: testLabel,
    SCRY_TEST_LOGIN_START_UNIT: testUnit,
    SCRY_TEST_LOGIN_START_DIR: serviceDir,
    SCRY_REMOTE_HOST: '1',
    SCRY_REMOTE_PERMISSION_MODE: 'auto_review',
    SCRY_REMOTE_RELAY_ENABLED: '0',
    SCRY_DISABLED_PROVIDERS: 'pi'
  }
  const manager = loginStart.createLoginStartManager({
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : 501,
    homeDir,
    daemonMode: true,
    allowLinux: true,
    systemctlAvailable: true,
    target: {
      executable: target.executable,
      appPath,
      resourcesPath,
      userDataDir,
      isPackaged: true
    },
    env: policyEnvInput,
    runner: async (_file, args) => {
      if (args[0] === 'print') return { exitCode: 113, stdout: '', timedOut: false, notFound: false }
      return { exitCode: 0, stdout: '', timedOut: false, notFound: false }
    }
  })

  const enabled = await manager.enable({ daemonRunning: false })
  if (!enabled.ok) fail('renderAndWrite', JSON.stringify(enabled))

  // 2. Verify private modes (logs dir 0700, daemon.log 0600, service file 0600) and strict round-trip parse.
  const logsDirMode = statSync(join(userDataDir, 'logs')).mode & 0o777
  const logFileMode = statSync(join(userDataDir, 'logs', 'daemon.log')).mode & 0o777
  const serviceFileMode = statSync(manager.filePath).mode & 0o777
  if (logsDirMode !== 0o700 || logFileMode !== 0o600 || serviceFileMode !== 0o600) {
    fail('permissions', `logs=${logsDirMode.toString(8)} log=${logFileMode.toString(8)} service=${serviceFileMode.toString(8)}`)
  }
  summary.steps.permissions = { ok: true, logsDir: '0700', logFile: '0600', serviceFile: '0600' }

  const rawService = readFileSync(manager.filePath, 'utf8')
  if (rawService.includes('VERSION')) fail('parseBack', 'service file unexpectedly contains VERSION')
  const parsed = process.platform === 'darwin'
    ? loginStart.parseLaunchdPlist(rawService, testLabel)
    : loginStart.parseSystemdUnit(rawService)
  if (parsed.kind !== 'ours' || parsed.executable !== target.executable || parsed.userDataDir !== userDataDir) {
    fail('parseBack', `unexpected parse result: ${JSON.stringify(parsed)}`)
  }
  summary.steps.parseBack = { ok: true, policyEnv: parsed.policyEnv }

  // 3. Launch the parsed executable + supervisorEntry in a minimal service-manager env
  //    (no SHELL, no user env; only minimal PATH/HOME + parsed service environment).
  const minimalEnv = {
    HOME: homeDir,
    PATH: '/usr/bin:/bin',
    ELECTRON_RUN_AS_NODE: '1',
    SCRY_DAEMON_STATE_DIR: stateDirectory,
    SCRY_DAEMON_USER_DATA_DIR: parsed.userDataDir,
    SCRY_DAEMON_ENTRY: parsed.daemonEntry,
    SCRY_DAEMON_APP_PATH: parsed.appPath,
    SCRY_DAEMON_RESOURCES_PATH: parsed.resourcesPath,
    // Keep actual packaged flag for source-mode runs so recorder CLI check matches target.
    SCRY_DAEMON_PACKAGED: target.packaged ? '1' : '0',
    SCRY_DAEMON_LAUNCHED_BY: 'service',
    ...Object.fromEntries(parsed.policyEnv.map((entry) => [entry.key, entry.value]))
  }
  supervisor = spawn(parsed.executable, [parsed.supervisorEntry], {
    env: minimalEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })
  let stderr = ''
  supervisor.stderr?.on('data', (chunk) => { if (stderr.length < 4096) stderr += String(chunk) })
  const alive = () => supervisor.exitCode === null && supervisor.signalCode === null

  if (!await waitForSocket(join(stateDirectory, 'local.sock'), 30_000, alive)) {
    fail('daemonReady', `local.sock not ready; exit=${supervisor.exitCode} stderr=${stderr.slice(0, 400)}`)
  }
  if (!await waitForSocket(join(stateDirectory, 'enroll.sock'), 10_000, alive)) {
    fail('daemonReady', `enroll.sock not ready; exit=${supervisor.exitCode}`)
  }

  const credentials = await enrollLocalDevice(stateDirectory)
  const info = await frame(stateDirectory, credentials, { op: 'daemonInfo' })
  if (info?.op !== 'daemonInfo' || info.version !== expectedVersion) {
    fail('handshake', `unexpected daemonInfo: ${JSON.stringify(info)} expected=${expectedVersion}`)
  }
  summary.steps.handshake = { ok: true, version: info.version, build: info.build ?? null }

  const selfReportReply = await frame(stateDirectory, credentials, {
    op: 'localBackgroundService',
    method: 'status',
    args: []
  })
  const report = selfReportReply?.result
  if (!report || report.launchedBy !== 'service' || report.supervisorPid !== supervisor.pid) {
    fail('selfReport', `unexpected self-report: ${JSON.stringify(selfReportReply)} supervisorPid=${supervisor.pid}`)
  }
  if (
    report.remoteConfig?.remoteHostEnabled !== true ||
    report.remoteConfig?.relayMode !== 'disabled' ||
    report.remoteConfig?.permissionModeOverride !== 'auto_review' ||
    JSON.stringify(report.remoteConfig?.disabledProviders) !== JSON.stringify(['pi'])
  ) {
    fail('selfReport', `remoteConfig mismatch: ${JSON.stringify(report.remoteConfig)}`)
  }
  const daemonPid = report.pid
  summary.steps.selfReport = {
    ok: true,
    daemonPid,
    supervisorPid: report.supervisorPid,
    launchedBy: report.launchedBy,
    remoteConfig: report.remoteConfig
  }

  // 5. SIGTERM the supervisor: daemon must exit BEFORE supervisor exits, with zero lock/socket leftovers.
  let daemonExitedAt = null
  let supervisorExitedAt = null
  const supervisorExitPromise = once(supervisor, 'exit').then(([code, signal]) => {
    supervisorExitedAt = Date.now()
    return { code, signal }
  })
  const daemonWatcher = (async () => {
    await waitUntil(() => !pidAlive(daemonPid), 25_000)
    daemonExitedAt = Date.now()
  })()

  supervisor.kill('SIGTERM')
  const [supExit] = await Promise.all([
    Promise.race([
      supervisorExitPromise,
      new Promise((r) => setTimeout(() => r({ code: null, signal: null, timedOut: true }), 26_000))
    ]),
    daemonWatcher
  ])
  if (supExit.timedOut || supExit.code !== 0) {
    fail('shutdown', `supervisor did not exit 0 cleanly: ${JSON.stringify(supExit)} stderr=${stderr.slice(0, 400)}`)
  }
  if (pidAlive(daemonPid)) fail('shutdown', `daemon pid ${daemonPid} still alive after supervisor exited`)
  if (daemonExitedAt !== null && supervisorExitedAt !== null && daemonExitedAt > supervisorExitedAt + 100) {
    fail('shutdown', `daemon exited after supervisor (daemon=${daemonExitedAt} supervisor=${supervisorExitedAt})`)
  }
  const leftovers = [
    join(stateDirectory, 'daemon.lock'),
    join(stateDirectory, 'local.sock'),
    join(stateDirectory, 'enroll.sock'),
    join(userDataDir, 'userdata.lock')
  ].filter((p) => existsSync(p))
  if (leftovers.length > 0) fail('shutdown', `leftover files after stop: ${leftovers.join(', ')}`)
  summary.steps.shutdown = { ok: true, supervisorExitCode: supExit.code, leftovers: [] }
  summary.ok = true
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
  summary.error = failure
} finally {
  if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
    supervisor.kill('SIGTERM')
    await Promise.race([once(supervisor, 'exit'), new Promise((r) => setTimeout(r, 5_000))])
  }
  rmSync(temp, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
process.exit(summary.ok ? 0 : 2)
