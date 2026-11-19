#!/usr/bin/env node
// P5-4 macOS real-machine LaunchAgent acceptance script.
// Drives real `/bin/launchctl` strictly against a unique test label
// (`com.scry.daemon.test.p54.<pid>`) and an isolated temporary userData directory —
// NEVER touches `com.scry.daemon`, `/Applications/Scry.app`, or daily userData.
//
// Usage:
//   node scripts/login-start-macos-acceptance.mjs --app dist/mac-arm64/Scry.app/Contents/MacOS/Scry
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
import { enrollLocalDevice, frame, waitForSocket } from './daemon-fixture.mjs'
import { parseSmokeArguments, resolvePackagedApp } from './daemon-mode-smoke/packaged.mjs'

if (process.platform !== 'darwin') {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'macos_only' })}\n`)
  process.exit(2)
}

const options = parseSmokeArguments(process.argv.slice(2))
if (!options.ok || !options.app) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'app_required' })}\n`)
  process.exit(2)
}
const target = resolvePackagedApp(options.app)
if (!target.ok) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: `target:${target.reason}`, detail: target })}\n`)
  process.exit(2)
}

const uid = process.getuid()
const testLabel = `com.scry.daemon.test.p54.${process.pid}`
const domain = `gui/${uid}`
const serviceTarget = `${domain}/${testLabel}`
const temp = realpathSync(mkdtempSync('/tmp/scry-p54-mac-'))
const userDataDir = join(temp, 'userData')
const stateDirectory = join(userDataDir, 'daemon')
const bundlePath = join(temp, 'login-start-bundle.mjs')
mkdirSync(userDataDir, { recursive: true, mode: 0o700 })

const timeline = []
const mark = (event, detail = {}) => timeline.push({ at: new Date().toISOString(), ms: Date.now(), event, ...detail })
const result = {
  ok: false,
  os: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
  locale: process.env.LANG ?? process.env.LC_ALL ?? 'unset',
  appVersion: target.version,
  executable: target.executable,
  testLabel,
  steps: {},
  timeline
}

function launchctl(args) {
  try {
    const stdout = execFileSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { exitCode: 0, stdout }
  } catch (error) {
    return {
      exitCode: typeof error.status === 'number' ? error.status : -1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? '')
    }
  }
}

function pidCommand(pid) {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 }).trim()
  } catch {
    return ''
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

let plistPath
try {
  buildSync({
    entryPoints: [resolve('src/daemon/login-start/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundlePath
  })
  const loginStart = await import(pathToFileURL(bundlePath).href)

  // 1. Refuse SCRY_REMOTE_RELAY_WS before writing any plist.
  const secretManager = loginStart.createLoginStartManager({
    platform: 'darwin',
    uid,
    homeDir: homedir(),
    daemonMode: true,
    target: {
      executable: target.executable,
      appPath: target.appArchive,
      resourcesPath: target.resources,
      userDataDir,
      isPackaged: true
    },
    env: {
      SCRY_TEST_APP: '1',
      SCRY_TEST_LOGIN_START_LABEL: testLabel,
      SCRY_REMOTE_RELAY_WS: JSON.stringify({ url: 'wss://relay.example', token: 'secret' })
    }
  })
  const secretOutcome = await secretManager.enable({ daemonRunning: false })
  if (secretOutcome.ok || secretOutcome.reason !== 'login_start_secret_env') {
    throw new Error(`secret_env_not_refused:${JSON.stringify(secretOutcome)}`)
  }
  result.steps.secretEnvRefused = { ok: true, reason: secretOutcome.reason }

  // 2. Enable login-start with real launchctl bootstrap against the test label.
  const manager = loginStart.createLoginStartManager({
    platform: 'darwin',
    uid,
    homeDir: homedir(),
    daemonMode: true,
    target: {
      executable: target.executable,
      appPath: target.appArchive,
      resourcesPath: target.resources,
      userDataDir,
      isPackaged: true
    },
    env: {
      SCRY_TEST_APP: '1',
      SCRY_TEST_LOGIN_START_LABEL: testLabel,
      SCRY_REMOTE_HOST: '1',
      SCRY_REMOTE_PERMISSION_MODE: 'auto_review',
      SCRY_REMOTE_RELAY_ENABLED: '0',
      SCRY_DISABLED_PROVIDERS: 'pi'
    }
  })
  plistPath = manager.filePath
  if (!plistPath.endsWith(`/${testLabel}.plist`) || plistPath.includes('com.scry.daemon.plist')) {
    throw new Error(`unsafe_plist_path:${plistPath}`)
  }

  mark('enable.start', { plistPath })
  const enabled = await manager.enable({ daemonRunning: false })
  if (!enabled.ok) throw new Error(`enable_failed:${JSON.stringify(enabled)}`)
  const printed = launchctl(['print', serviceTarget])
  if (printed.exitCode !== 0) throw new Error(`launchctl_print_failed:${printed.exitCode}`)
  mark('enable.done', { printExit: printed.exitCode })
  result.steps.enableAndPrint = {
    ok: true,
    plistPath,
    plistMode: (statSync(plistPath).mode & 0o777).toString(8),
    logsDirMode: (statSync(join(userDataDir, 'logs')).mode & 0o777).toString(8),
    logFileMode: (statSync(join(userDataDir, 'logs', 'daemon.log')).mode & 0o777).toString(8),
    printExitCode: printed.exitCode
  }

  // 3. Verify RunAtLoad/kickstart starts daemon without App, client connects, SHELL + policy match.
  const kicked = launchctl(['kickstart', serviceTarget])
  mark('kickstart', { exitCode: kicked.exitCode })
  if (!await waitForSocket(join(stateDirectory, 'local.sock'), 20_000, () => true)) {
    throw new Error('local_socket_timeout')
  }
  if (!await waitForSocket(join(stateDirectory, 'enroll.sock'), 10_000, () => true)) {
    throw new Error('enroll_socket_timeout')
  }
  const credentials = await enrollLocalDevice(stateDirectory)
  const info = await frame(stateDirectory, credentials, { op: 'daemonInfo' })
  const statusReply = await frame(stateDirectory, credentials, { op: 'localBackgroundService', method: 'status', args: [] })
  const report = statusReply?.result
  if (!report || report.launchedBy !== 'service' || typeof report.supervisorPid !== 'number') {
    throw new Error(`unexpected_self_report:${JSON.stringify(statusReply)}`)
  }
  if (
    report.remoteConfig?.remoteHostEnabled !== true ||
    report.remoteConfig?.relayMode !== 'disabled' ||
    report.remoteConfig?.permissionModeOverride !== 'auto_review' ||
    JSON.stringify(report.remoteConfig?.disabledProviders) !== JSON.stringify(['pi'])
  ) {
    throw new Error(`unexpected_remote_config:${JSON.stringify(report.remoteConfig)}`)
  }
  const daemonEnvLine = execFileSync('/bin/ps', ['eww', '-p', String(report.pid), '-o', 'command='], { encoding: 'utf8' })
  const shellMatch = daemonEnvLine.match(/\bSHELL=([^\s]+)/)
  if (!shellMatch) throw new Error('daemon_missing_SHELL_in_launchd_env')
  mark('daemon.verified', { daemonPid: report.pid, supervisorPid: report.supervisorPid, shell: shellMatch[1] })
  result.steps.serviceLaunchedDaemon = {
    ok: true,
    version: info.version,
    daemonPid: report.pid,
    supervisorPid: report.supervisorPid,
    launchedBy: report.launchedBy,
    shell: shellMatch[1],
    remoteConfig: report.remoteConfig
  }

  // 4. Disable login-start while daemon is running: plist deleted, running daemon NOT stopped.
  const disabled = await manager.disable({ daemonRunning: true })
  if (!disabled.ok) throw new Error(`disable_failed:${JSON.stringify(disabled)}`)
  if (existsSync(plistPath)) throw new Error('plist_not_deleted_on_disable')
  const stillResponding = await frame(stateDirectory, credentials, { op: 'daemonInfo' })
  if (stillResponding?.op !== 'daemonInfo') throw new Error('daemon_stopped_unexpectedly_on_disable')
  mark('disable.done', { plistDeleted: true, daemonStillAlive: pidAlive(report.pid) })
  result.steps.disableKeepsDaemonRunning = {
    ok: true,
    plistDeleted: !existsSync(plistPath),
    daemonStillAlive: pidAlive(report.pid)
  }

  // 5. Re-enable while job is still loaded and daemon running (P5 §6 checklist).
  const reenabled = await manager.enable({ daemonRunning: true })
  if (!reenabled.ok) throw new Error(`reenable_failed:${JSON.stringify(reenabled)}`)
  result.steps.reenableWhileRunning = { ok: true, plistExists: existsSync(plistPath) }

  // 6. Crash recovery under KeepAlive={Crashed:true}: verify supervisor PID belongs to our
  //    packaged binary, send SIGABRT (crash signal), wait for launchd ThrottleInterval (10 s),
  //    and confirm launchd spawns a new supervisor + daemon and the existing client reconnects.
  const firstSupervisorPid = report.supervisorPid
  const supCmd = pidCommand(firstSupervisorPid)
  if (!supCmd.includes(target.executable) || !supCmd.includes('daemon-supervisor.js')) {
    throw new Error(`supervisor_identity_mismatch:pid=${firstSupervisorPid} cmd=${supCmd}`)
  }
  const crashAt = Date.now()
  mark('crash_supervisor.sigabrt', { pid: firstSupervisorPid })
  process.kill(firstSupervisorPid, 'SIGABRT')
  let newSupervisorPid = null
  const restarted = await waitUntil(() => {
    const p = launchctl(['print', serviceTarget])
    const pidMatch = p.stdout.match(/\bpid = (\d+)/)
    if (pidMatch && Number(pidMatch[1]) !== firstSupervisorPid) {
      newSupervisorPid = Number(pidMatch[1])
      return true
    }
    return false
  }, 25_000)
  if (!restarted || !newSupervisorPid) {
    throw new Error(`keepalive_crashed_no_restart:print=${launchctl(['print', serviceTarget]).stdout.slice(0, 600)}`)
  }
  if (!await waitForSocket(join(stateDirectory, 'local.sock'), 20_000, () => true)) {
    throw new Error('restarted_daemon_socket_timeout')
  }
  const afterCrashReply = await frame(stateDirectory, credentials, { op: 'localBackgroundService', method: 'status', args: [] })
  const afterCrash = afterCrashReply?.result
  if (!afterCrash || afterCrash.launchedBy !== 'service' || afterCrash.supervisorPid !== newSupervisorPid) {
    throw new Error(`restarted_daemon_unexpected:${JSON.stringify(afterCrashReply)} expectedSup=${newSupervisorPid}`)
  }
  const crashRecoveryMs = Date.now() - crashAt
  mark('crash_supervisor.recovered', {
    oldSupervisorPid: firstSupervisorPid,
    newSupervisorPid,
    newDaemonPid: afterCrash.pid,
    elapsedMs: crashRecoveryMs
  })
  result.steps.keepAliveCrashedSigabrt = {
    ok: true,
    oldSupervisorPid: firstSupervisorPid,
    newSupervisorPid,
    newDaemonPid: afterCrash.pid,
    elapsedMs: crashRecoveryMs
  }

  // 7. Bootout test label: daemon must finish cleanly within 30 s with zero lock/socket leftovers.
  const bootoutStart = Date.now()
  mark('bootout.start', { daemonPid: afterCrash.pid, supervisorPid: newSupervisorPid })
  const booted = launchctl(['bootout', serviceTarget])
  const daemonExited = await waitUntil(() => !pidAlive(afterCrash.pid) && !pidAlive(newSupervisorPid), 28_000)
  const bootoutElapsedMs = Date.now() - bootoutStart
  mark('bootout.done', { exitCode: booted.exitCode, daemonExited, elapsedMs: bootoutElapsedMs })
  const leftovers = [
    join(stateDirectory, 'daemon.lock'),
    join(stateDirectory, 'local.sock'),
    join(stateDirectory, 'enroll.sock'),
    join(userDataDir, 'userdata.lock')
  ].filter((p) => existsSync(p))
  if (!daemonExited || leftovers.length > 0) {
    throw new Error(`bootout_incomplete:daemonExited=${daemonExited} elapsedMs=${bootoutElapsedMs} leftovers=${leftovers.join(',')}`)
  }
  result.steps.bootoutShutdown = {
    ok: true,
    bootoutExitCode: booted.exitCode,
    elapsedMs: bootoutElapsedMs,
    leftovers
  }

  result.ok = true
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
} finally {
  launchctl(['bootout', serviceTarget])
  if (plistPath && existsSync(plistPath) && plistPath.includes(testLabel)) {
    try { rmSync(plistPath, { force: true }) } catch { /* ignore */ }
  }
  rmSync(temp, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(result.ok ? 0 : 2)
