import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLoginStartManager, loginStartTemplateInput, parseLaunchctlPrint, runFixedCommand,
  type CommandResult, type CommandRunner, type ServiceFileRead
} from './index'
import { renderLaunchdPlist } from '../supervisor-templates'

// W2 review S2, S7, S8 & optional edge cases: symlink refusal, bootout ownership,
// rollback restoring previous file, Linux start-failure rollback, ephemeral macOS paths,
// read errors (EACCES), and real execFile timeout / ENOENT handling.

const roots: string[] = []
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-login-start-edge-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, timedOut: false, notFound: false })
const fail = (exitCode = 1, stdout = ''): CommandResult => ({ exitCode, stdout, timedOut: false, notFound: false })

function makeSetup(options: {
  platform?: NodeJS.Platform
  executableOverride?: string
  env?: NodeJS.ProcessEnv
  allowLinux?: boolean
  runner?: CommandRunner
  readServiceFile?: (path: string) => ServiceFileRead
} = {}) {
  const root = tempRoot()
  const homeDir = join(root, 'home')
  const userDataDir = join(root, 'userData')
  const appDir = join(root, 'Scry.app', 'Contents')
  const executable = options.executableOverride ?? join(appDir, 'MacOS', 'Scry')
  const resourcesPath = join(appDir, 'Resources')
  const appPath = join(resourcesPath, 'app.asar')
  mkdirSync(join(appDir, 'MacOS'), { recursive: true })
  mkdirSync(resourcesPath, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  if (!options.executableOverride) writeFileSync(executable, '')
  const calls: Array<{ file: string; args: string[] }> = []
  const runner: CommandRunner = options.runner ?? (async (file, args) => {
    calls.push({ file, args })
    return ok()
  })
  const manager = createLoginStartManager({
    platform: options.platform ?? 'darwin',
    uid: 501,
    homeDir,
    
    allowLinux: options.allowLinux ?? false,
    systemctlAvailable: true,
    target: { executable, appPath, resourcesPath, userDataDir, isPackaged: true },
    env: options.env ?? {},
    runner,
    ...(options.readServiceFile ? { readServiceFile: options.readServiceFile } : {})
  })
  return { root, homeDir, userDataDir, executable, appPath, resourcesPath, calls, manager }
}

describe('login-start security & rollback edge cases (S2, S7, S8)', () => {
  it('refuses symlink at service file path on both enable and disable without touching target (S8)', async () => {
    const { root, homeDir, calls, manager } = makeSetup()
    const targetFile = join(root, 'outside-secret.txt')
    writeFileSync(targetFile, 'do-not-touch')
    const agentsDir = join(homeDir, 'Library', 'LaunchAgents')
    mkdirSync(agentsDir, { recursive: true })
    symlinkSync(targetFile, join(agentsDir, 'com.scry.daemon.plist'))

    expect(await manager.enable({ daemonRunning: false })).toEqual({ ok: false, reason: 'login_start_foreign_service' })
    expect(await manager.disable({ daemonRunning: false })).toEqual({ ok: false, reason: 'login_start_foreign_service' })
    expect(readFileSync(targetFile, 'utf8')).toBe('do-not-touch')
    expect(calls).toEqual([])
  })

  it('never runs bootout when service file is missing on disable or enable (S2)', async () => {
    const calls: string[][] = []
    const { manager } = makeSetup({
      runner: async (_file, args) => { calls.push(args); return ok() }
    })
    // Disable with no plist: no bootout!
    expect(await manager.disable({ daemonRunning: false })).toEqual({ ok: true })
    expect(calls).toEqual([])

    // Enable with no prior plist, daemon not running, but launchctl print says loaded:
    // refuses without bootout and cleans up the written file!
    expect(await manager.enable({ daemonRunning: false })).toEqual({ ok: false, reason: 'login_start_loaded_without_file' })
    expect(calls).toEqual([['print', 'gui/501/com.scry.daemon']])
    expect(existsSync(manager.filePath)).toBe(false)
  })

  it('restores the previous valid plist verbatim when updating and bootstrap fails (S8)', async () => {
    const s = makeSetup({
      env: { SCRY_REMOTE_HOST: '0' },
      runner: async (_file, args) => args[0] === 'bootstrap' ? fail(125) : ok()
    })
    const agentsDir = join(s.homeDir, 'Library', 'LaunchAgents')
    mkdirSync(agentsDir, { recursive: true })
    const previousPlist = renderLaunchdPlist(loginStartTemplateInput({
      executable: s.executable, appPath: s.appPath, resourcesPath: s.resourcesPath, userDataDir: s.userDataDir, isPackaged: true
    }, { policyEnv: [['SCRY_REMOTE_HOST', '1']] }))
    writeFileSync(s.manager.filePath, previousPlist, { mode: 0o600 })

    expect(await s.manager.enable({ daemonRunning: false })).toEqual({
      ok: false, reason: 'login_start_bootstrap_failed', exitCode: 125
    })
    expect(readFileSync(s.manager.filePath, 'utf8')).toBe(previousPlist)
  })

  it('rolls back unit file and disables service when Linux systemctl start fails (S7)', async () => {
    const calls: string[][] = []
    const { manager } = makeSetup({
      platform: 'linux',
      allowLinux: true,
      runner: async (_file, args) => {
        calls.push(args)
        if (args[1] === 'start') return fail(1)
        return ok()
      }
    })
    expect(await manager.enable({ daemonRunning: false })).toEqual({
      ok: false, reason: 'login_start_systemctl_start_failed', exitCode: 1
    })
    expect(existsSync(manager.filePath)).toBe(false)
    expect(calls).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', 'scry-daemon.service'],
      ['--user', 'start', 'scry-daemon.service'],
      ['--user', 'disable', 'scry-daemon.service'],
      ['--user', 'daemon-reload']
    ])
  })

  it('refuses ephemeral macOS DMG / AppTranslocation paths and distinguishes EACCES read errors (root-safe)', async () => {
    const dmg = makeSetup({ executableOverride: '/Volumes/Scry/Scry.app/Contents/MacOS/Scry' })
    expect(dmg.manager.availability()).toEqual({ ok: false, reason: 'login_start_ephemeral_app_path' })
    expect(await dmg.manager.status()).toEqual({ state: 'unavailable', reason: 'login_start_ephemeral_app_path' })

    const eacces = makeSetup({ readServiceFile: () => ({ kind: 'error', code: 'EACCES' }) })
    expect(await eacces.manager.status()).toEqual({ state: 'unavailable', reason: 'login_start_read_failed:EACCES' })
    expect(await eacces.manager.enable({ daemonRunning: false })).toEqual({ ok: false, reason: 'login_start_read_failed:EACCES' })
    expect(await eacces.manager.disable({ daemonRunning: false })).toEqual({ ok: false, reason: 'login_start_read_failed:EACCES' })
  })

  it('parseLaunchctlPrint distinguishes top-level idle/running and ignores inherited env / nested coalition state', () => {
    const idleWithCoalition = [
      'gui/501/com.scry.daemon = {',
      '\tstate = not running',
      '\tinherited environment = {',
      '\t\tSCRY_DAEMON_USER_DATA_DIR => /spoofed/inherited',
      '\t}',
      '\tenvironment = {',
      '\t\tSCRY_DAEMON_USER_DATA_DIR => /private/tmp/测试 用户',
      '\t}',
      '\tresource coalition = {',
      '\t\tstate = active',
      '\t}',
      '}'
    ].join('\n')
    expect(parseLaunchctlPrint(idleWithCoalition)).toEqual({
      runState: 'idle',
      userDataDir: '/private/tmp/测试 用户'
    })
    expect(parseLaunchctlPrint('gui/501/com.scry.daemon = {\n\tstate = running\n\tpid = 88\n}\n')).toEqual({
      runState: 'running',
      userDataDir: null
    })
    expect(parseLaunchctlPrint('')).toEqual({ runState: 'unknown', userDataDir: null })
  })

  it('allows re-enable after disable(running) -> daemon stops when launchctl print shows idle job (R2 #1)', async () => {
    const calls: string[][] = []
    let loaded = false
    let running = false
    let loadedUserData = ''
    const { userDataDir, manager } = makeSetup({
      runner: async (_file, args) => {
        calls.push(args)
        if (args[0] === 'print') {
          if (!loaded) return fail(113)
          return ok(
            `gui/501/com.scry.daemon = {\n\tstate = ${running ? 'running' : 'not running'}\n` +
            `\tenvironment = {\n\t\tSCRY_DAEMON_USER_DATA_DIR => ${loadedUserData}\n\t}\n` +
            (running ? '\tpid = 4321\n' : '') + '}\n'
          )
        }
        if (args[0] === 'bootstrap') { loaded = true; running = true; loadedUserData = userDataDir; return ok() }
        if (args[0] === 'bootout') { loaded = false; running = false; return ok() }
        return ok()
      }
    })
    expect(await manager.enable({ daemonRunning: false })).toEqual({ ok: true })
    expect(await manager.disable({ daemonRunning: true })).toEqual({ ok: true })
    expect(existsSync(manager.filePath)).toBe(false)
    // Daemon subsequently stops cleanly while the launchd job stays loaded & idle.
    running = false
    calls.length = 0

    expect(await manager.enable({ daemonRunning: false })).toEqual({ ok: true })
    expect(existsSync(manager.filePath)).toBe(true)
    expect(calls).toEqual([
      ['print', 'gui/501/com.scry.daemon'],
      ['bootout', 'gui/501/com.scry.daemon'],
      ['bootstrap', 'gui/501', manager.filePath]
    ])
  })

  it('refuses enable(daemonRunning=true) when loaded job has no file and cannot prove ownership (R2 #2)', async () => {
    const otherRunning =
      'gui/501/com.scry.daemon = {\n\tstate = running\n\tenvironment = {\n\t\tSCRY_DAEMON_USER_DATA_DIR => /other/userData\n\t}\n\tpid = 9999\n}\n'
    const calls1: string[][] = []
    const s1 = makeSetup({ runner: async (_f, args) => { calls1.push(args); return ok(otherRunning) } })
    expect(await s1.manager.enable({ daemonRunning: true })).toEqual({ ok: false, reason: 'login_start_loaded_without_file' })
    expect(existsSync(s1.manager.filePath)).toBe(false)
    expect(calls1).toEqual([['print', 'gui/501/com.scry.daemon']])

    // Empty/unparseable print output with no file on disk also fails closed even if daemonRunning=true.
    const calls2: string[][] = []
    const s2 = makeSetup({ runner: async (_f, args) => { calls2.push(args); return ok('') } })
    expect(await s2.manager.enable({ daemonRunning: true })).toEqual({ ok: false, reason: 'login_start_loaded_without_file' })
    expect(existsSync(s2.manager.filePath)).toBe(false)
    expect(calls2).toEqual([['print', 'gui/501/com.scry.daemon']])
  })

  it('allows enable(daemonRunning=true) after disable(running) when launchctl print proves same userData (R2 #2)', async () => {
    const calls: string[][] = []
    let userData = ''
    const s = makeSetup({
      runner: async (_f, args) => {
        calls.push(args)
        return ok(
          `gui/501/com.scry.daemon = {\n\tstate = running\n\tenvironment = {\n\t\tSCRY_DAEMON_USER_DATA_DIR => ${userData}\n\t}\n\tpid = 4321\n}\n`
        )
      }
    })
    userData = s.userDataDir
    expect(await s.manager.enable({ daemonRunning: true })).toEqual({ ok: true })
    expect(existsSync(s.manager.filePath)).toBe(true)
    expect(calls).toEqual([['print', 'gui/501/com.scry.daemon']])
  })

  it('startViaService skips bootout when job is already running for our userData and refuses other userData; disable refuses other existing app', async () => {
    const calls: string[][] = []
    let printOut = ''
    const s = makeSetup({ runner: async (_f, args) => { calls.push(args); return args[0] === 'print' ? ok(printOut) : ok() } })
    mkdirSync(join(s.homeDir, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(s.manager.filePath, renderLaunchdPlist(loginStartTemplateInput({
      executable: s.executable, appPath: s.appPath, resourcesPath: s.resourcesPath, userDataDir: s.userDataDir, isPackaged: true
    })), { mode: 0o600 })

    // Already running for our userData -> do not bootout (avoids ExitTimeOut=30 vs 10 s command timeout).
    printOut = `gui/501/com.scry.daemon = {\n\tstate = running\n\tenvironment = {\n\t\tSCRY_DAEMON_USER_DATA_DIR => ${s.userDataDir}\n\t}\n\tpid = 4321\n}\n`
    expect(await s.manager.startViaService()).toEqual({ ok: true })
    expect(calls).toEqual([['print', 'gui/501/com.scry.daemon']])

    // Running for another userData -> refuse, never bootout.
    calls.length = 0
    printOut = 'gui/501/com.scry.daemon = {\n\tstate = running\n\tenvironment = {\n\t\tSCRY_DAEMON_USER_DATA_DIR => /other/userData\n\t}\n\tpid = 9999\n}\n'
    expect(await s.manager.startViaService()).toEqual({ ok: false, reason: 'login_start_other_userdata', otherUserDataDir: '/other/userData' })
    expect(calls).toEqual([['print', 'gui/501/com.scry.daemon']])

    // Disable refuses plist belonging to another still-existing App.
    const otherExec = join(s.root, 'Other.app', 'Contents', 'MacOS', 'Scry')
    mkdirSync(join(s.root, 'Other.app', 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(otherExec, '')
    const otherPlist = renderLaunchdPlist(loginStartTemplateInput({
      executable: otherExec, appPath: join(s.root, 'Other.app', 'Contents', 'Resources', 'app.asar'),
      resourcesPath: join(s.root, 'Other.app', 'Contents', 'Resources'), userDataDir: s.userDataDir, isPackaged: true
    }))
    writeFileSync(s.manager.filePath, otherPlist, { mode: 0o600 })
    calls.length = 0
    expect(await s.manager.disable({ daemonRunning: false })).toEqual({
      ok: false, reason: 'login_start_other_app', otherExecutable: otherExec
    })
    expect(readFileSync(s.manager.filePath, 'utf8')).toBe(otherPlist)
    expect(calls).toEqual([])
  })

  it('runFixedCommand reports real execFile timeout and missing binary (S8)', async () => {
    const missing = await runFixedCommand('/nonexistent/scry-no-such-binary-xyz', [], 1_000)
    expect(missing).toEqual({ exitCode: null, stdout: '', timedOut: false, notFound: true })

    const timedOut = await runFixedCommand('/bin/sleep', ['5'], 120)
    expect(timedOut.timedOut).toBe(true)
    expect(timedOut.exitCode).not.toBe(0)
  })
})
