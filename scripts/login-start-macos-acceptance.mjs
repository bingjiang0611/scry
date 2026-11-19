#!/usr/bin/env node
// P5-4 macOS real-machine LaunchAgent acceptance script (W2 review S3 + S6).
// Drives real `/bin/launchctl` strictly against a unique test label
// (`com.scry.daemon.test.p54.<pid>`), a temporary service-file directory
// (`SCRY_TEST_LOGIN_START_DIR`, never touching `~/Library/LaunchAgents`), and an isolated
// userData path containing spaces and Chinese characters. Registers SIGINT/SIGTERM
// cleanup so interruption never leaves a background service behind.
//
// Note: invokes the plain-Node login-start module directly (not Electron main IPC or
// native confirmation dialogs, which are verified by unit tests).
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
const temp = realpathSync(mkdtempSync('/tmp/scry-p54-'))
// Default macOS userData has spaces; also cover Chinese characters (within 104-byte SUN_LEN).
const userDataDir = join(temp, '测试 用户')
const serviceDir = join(temp, 'launch agents')
const stateDirectory = join(userDataDir, 'daemon')
const bundlePath = join(temp, 'login-start-bundle.mjs')
mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
mkdirSync(serviceDir, { recursive: true, mode: 0o700 })

const timeline = []
const mark = (event, detail = {}) => timeline.push({ at: new Date().toISOString(), ms: Date.now(), event, ...detail })
const result = {
  ok: false,
  os: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
  locale: process.env.LANG ?? process.env.LC_ALL ?? 'unset',
  appVersion: target.version,
  executable: target.executable,
  testLabel,
  userDataDir,
  serviceDir,
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

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  launchctl(['bootout', serviceTarget])
  try { rmSync(temp, { recursive: true, force: true }) } catch { /* ignore */ }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
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

  const makeManager = (envOverrides) => loginStart.createLoginStartManager({
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
      SCRY_TEST_LOGIN_START_DIR: serviceDir,
      ...envOverrides
    }
  })

  // 1. Refuse SCRY_REMOTE_RELAY_WS before writing any plist.
  const secretManager = makeManager({
    SCRY_REMOTE_RELAY_WS: JSON.stringify({ url: 'wss://relay.example', token: 'secret' })
  })
  const secretOutcome = await secretManager.enable({ daemonRunning: false })
  if (secretOutcome.ok || secretOutcome.reason !== 'login_start_secret_env') {
    throw new Error(`secret_env_not_refused:${JSON.stringify(secretOutcome)}`)
  }
  result.steps.secretEnvRefused = { ok: true, reason: secretOutcome.reason }

  // 2. Enable login-start into temp serviceDir (never ~/Library/LaunchAgents) with real launchctl bootstrap.
  const manager = makeManager({
    SCRY_REMOTE_HOST: '1',
    SCRY_REMOTE_PERMISSION_MODE: 'auto_review',
    SCRY_REMOTE_RELAY_ENABLED: '0',
    SCRY_DISABLED_PROVIDERS: 'pi'
  })
  const plistPath = manager.filePath
  if (!plistPath.startsWith(serviceDir) || plistPath.includes('Library/LaunchAgents')) {
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

  // 3. Verify RunAtLoad starts daemon without App, client connects, SHELL + policy match.
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

  // 4. Disable while daemon is running: plist deleted, running daemon NOT stopped.
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

  // 5. S3 live verification: re-enable with UPDATED policy env while daemon is running,
  //    then stop daemon cleanly and launch via startViaService() — launchd must load the
  //    NEW plist definition (permissionModeOverride=auto_accept_edits), not stale auto_review!
  const updatedManager = makeManager({
    SCRY_REMOTE_HOST: '1',
    SCRY_REMOTE_PERMISSION_MODE: 'auto_accept_edits',
    SCRY_REMOTE_RELAY_ENABLED: '0',
    SCRY_DISABLED_PROVIDERS: 'pi'
  })
  const reenabled = await updatedManager.enable({ daemonRunning: true })
  if (!reenabled.ok) throw new Error(`reenable_failed:${JSON.stringify(reenabled)}`)
  const supCmd = pidCommand(report.supervisorPid)
  if (!supCmd.includes(target.executable) || !supCmd.includes('daemon-supervisor.js')) {
    throw new Error(`supervisor_identity_mismatch:pid=${report.supervisorPid} cmd=${supCmd}`)
  }
  mark('s3.stop_old_daemon', { supervisorPid: report.supervisorPid, daemonPid: report.pid })
  process.kill(report.supervisorPid, 'SIGTERM')
  if (!await waitUntil(() => !pidAlive(report.pid) && !pidAlive(report.supervisorPid), 20_000)) {
    throw new Error('s3_old_daemon_stop_timeout')
  }
  const relaunched = await updatedManager.startViaService()
  if (!relaunched.ok) throw new Error(`s3_start_via_service_failed:${JSON.stringify(relaunched)}`)
  if (!await waitForSocket(join(stateDirectory, 'local.sock'), 20_000, () => true)) {
    throw new Error('s3_reloaded_socket_timeout')
  }
  const reloadedReply = await frame(stateDirectory, credentials, { op: 'localBackgroundService', method: 'status', args: [] })
  const reloaded = reloadedReply?.result
  if (!reloaded || reloaded.remoteConfig?.permissionModeOverride !== 'auto_accept_edits') {
    throw new Error(`s3_stale_definition_loaded:${JSON.stringify(reloadedReply)}`)
  }
  mark('s3.reloaded_verified', { daemonPid: reloaded.pid, supervisorPid: reloaded.supervisorPid, permissionModeOverride: reloaded.remoteConfig.permissionModeOverride })
  result.steps.reloadChangedDefinition = {
    ok: true,
    oldPermissionMode: 'auto_review',
    newPermissionMode: reloaded.remoteConfig.permissionModeOverride,
    newSupervisorPid: reloaded.supervisorPid,
    newDaemonPid: reloaded.pid
  }

  // 6. Crash recovery under KeepAlive={Crashed:true}: SIGABRT verified supervisor PID,
  //    confirm launchd restarts supervisor + daemon after default 10 s ThrottleInterval.
  const preCrashSupervisorPid = reloaded.supervisorPid
  const preCrashCmd = pidCommand(preCrashSupervisorPid)
  if (!preCrashCmd.includes(target.executable) || !preCrashCmd.includes('daemon-supervisor.js')) {
    throw new Error(`supervisor_identity_mismatch:pid=${preCrashSupervisorPid} cmd=${preCrashCmd}`)
  }
  const crashAt = Date.now()
  mark('crash_supervisor.sigabrt', { pid: preCrashSupervisorPid })
  process.kill(preCrashSupervisorPid, 'SIGABRT')
  let newSupervisorPid = null
  const restarted = await waitUntil(() => {
    const p = launchctl(['print', serviceTarget])
    const pidMatch = p.stdout.match(/\bpid = (\d+)/)
    if (pidMatch && Number(pidMatch[1]) !== preCrashSupervisorPid) {
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
    oldSupervisorPid: preCrashSupervisorPid,
    newSupervisorPid,
    newDaemonPid: afterCrash.pid,
    elapsedMs: crashRecoveryMs
  })
  result.steps.keepAliveCrashedSigabrt = {
    ok: true,
    oldSupervisorPid: preCrashSupervisorPid,
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
  cleanup()
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(result.ok ? 0 : 2)
