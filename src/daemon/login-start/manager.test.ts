import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoginStartManager, loginStartTemplateInput, type CommandResult, type CommandRunner } from './index'
import { renderLaunchdPlist } from '../supervisor-templates'

const roots: string[] = []
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-login-start-'))
  roots.push(dir)
  return dir
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, timedOut: false, notFound: false })
const fail = (exitCode = 1, stdout = ''): CommandResult => ({ exitCode, stdout, timedOut: false, notFound: false })

function setup(options: {
  platform?: NodeJS.Platform
  isPackaged?: boolean
  env?: NodeJS.ProcessEnv
  allowLinux?: boolean
  systemctlAvailable?: boolean
  exec?: CommandRunner
} = {}) {
  const root = tempRoot()
  const homeDir = join(root, 'home')
  const userDataDir = join(root, 'userData')
  const appDir = join(root, 'Scry.app', 'Contents')
  const executable = join(appDir, 'MacOS', 'Scry')
  const resourcesPath = join(appDir, 'Resources')
  const appPath = join(resourcesPath, 'app.asar')
  mkdirSync(join(appDir, 'MacOS'), { recursive: true })
  mkdirSync(resourcesPath, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(executable, '')
  const calls: Array<{ file: string; args: string[] }> = []
  const runner: CommandRunner = options.exec ?? (async (file, args) => {
    calls.push({ file, args })
    return ok()
  })
  const manager = createLoginStartManager({
    platform: options.platform ?? 'darwin',
    uid: 501,
    homeDir,
    target: { executable, appPath, resourcesPath, userDataDir, isPackaged: options.isPackaged ?? true },
    env: options.env ?? {},
    runner,
    ...(options.allowLinux !== undefined ? { allowLinux: options.allowLinux } : {}),
    ...(options.systemctlAvailable !== undefined ? { systemctlAvailable: options.systemctlAvailable } : {})
  })
  return { root, homeDir, userDataDir, executable, appPath, resourcesPath, calls, manager }
}

describe('login-start manager', () => {
  it('enforces platform, packaged, and test-instance gating', async () => {
    expect(await setup({ isPackaged: false }).manager.status()).toEqual({ state: 'unavailable', reason: 'unpackaged_build' })
    expect(await setup({ env: { SCRY_TEST_APP: '1' } }).manager.status()).toEqual({ state: 'unavailable', reason: 'test_instance' })
    expect(await setup({ platform: 'linux' }).manager.status()).toEqual({ state: 'unavailable', reason: 'linux_unverified' })
    expect(await setup({ platform: 'linux', allowLinux: true, systemctlAvailable: false }).manager.status())
      .toEqual({ state: 'unavailable', reason: 'systemd_unavailable' })
    expect(await setup({ platform: 'win32' }).manager.status()).toEqual({ state: 'unavailable', reason: 'unsupported_platform' })
  })

  it('macOS enable precreates log (0700/0600), writes plist (0600) with policy env, and runs print -> bootstrap', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const { homeDir, userDataDir, manager } = setup({
      env: { SCRY_REMOTE_HOST: '1', SCRY_REMOTE_PERMISSION_MODE: 'auto_review' },
      exec: async (file, args) => {
        calls.push({ file, args })
        if (args[0] === 'print') return fail(113)
        return ok()
      }
    })
    expect(await manager.enable({ daemonRunning: false })).toEqual({ ok: true })
    const plistPath = join(homeDir, 'Library', 'LaunchAgents', 'com.scry.daemon.plist')
    expect(existsSync(plistPath)).toBe(true)
    expect(statSync(plistPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(userDataDir, 'logs')).mode & 0o777).toBe(0o700)
    expect(statSync(join(userDataDir, 'logs', 'daemon.log')).mode & 0o777).toBe(0o600)
    expect(calls).toEqual([
      { file: '/bin/launchctl', args: ['print', 'gui/501/com.scry.daemon'] },
      { file: '/bin/launchctl', args: ['bootstrap', 'gui/501', plistPath] }
    ])
    expect(readFileSync(plistPath, 'utf8')).toContain('<key>SCRY_REMOTE_PERMISSION_MODE</key><string>auto_review</string>')
  })

  it('macOS enable keeps a running daemon untouched when already loaded (with ownership proof), and bootout+bootstrap when owned file existed', async () => {
    const calls1: string[][] = []
    let s1UserData = ''
    const s1 = setup({
      exec: async (_file, args) => {
        calls1.push(args)
        return ok(`gui/501/com.scry.daemon = {\n\tstate = running\n\tenvironment = {\n\t\tSCRY_DAEMON_USER_DATA_DIR => ${s1UserData}\n\t}\n\tpid = 4321\n}\n`)
      }
    })
    s1UserData = s1.userDataDir
    expect(await s1.manager.enable({ daemonRunning: true })).toEqual({ ok: true })
    expect(calls1).toEqual([['print', 'gui/501/com.scry.daemon']])

    const calls2: string[][] = []
    const s2 = setup({ exec: async (_file, args) => { calls2.push(args); return ok() } })
    const plistPath = join(s2.homeDir, 'Library', 'LaunchAgents', 'com.scry.daemon.plist')
    mkdirSync(join(s2.homeDir, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(plistPath, renderLaunchdPlist(loginStartTemplateInput({
      executable: s2.executable, appPath: s2.appPath, resourcesPath: s2.resourcesPath, userDataDir: s2.userDataDir, isPackaged: true
    })), { mode: 0o600 })
    expect(await s2.manager.enable({ daemonRunning: false })).toEqual({ ok: true })
    expect(calls2).toEqual([
      ['print', 'gui/501/com.scry.daemon'],
      ['bootout', 'gui/501/com.scry.daemon'],
      ['bootstrap', 'gui/501', plistPath]
    ])
  })

  it('macOS enable reverts newly created plist if bootstrap fails, and refuses secret env before writing', async () => {
    const secret = setup({ env: { SCRY_REMOTE_RELAY_WS: '{"url":"wss://r.example","token":"t"}' } })
    expect(await secret.manager.enable({ daemonRunning: false })).toEqual({ ok: false, reason: 'login_start_secret_env' })
    expect(existsSync(join(secret.homeDir, 'Library', 'LaunchAgents', 'com.scry.daemon.plist'))).toBe(false)

    const failed = setup({ exec: async (_file, args) => args[0] === 'print' ? fail(113) : fail(125) })
    expect(await failed.manager.enable({ daemonRunning: false })).toEqual({
      ok: false, reason: 'login_start_bootstrap_failed', exitCode: 125
    })
    expect(existsSync(join(failed.homeDir, 'Library', 'LaunchAgents', 'com.scry.daemon.plist'))).toBe(false)
  })

  it('macOS disable deletes plist, skips bootout while daemon is running, and runs bootout when owned file existed & stopped', async () => {
    const callsRunning: string[][] = []
    const s1 = setup({ exec: async (_f, args) => { callsRunning.push(args); return args[0] === 'print' ? fail(113) : ok() } })
    await s1.manager.enable({ daemonRunning: false })
    callsRunning.length = 0
    expect(await s1.manager.disable({ daemonRunning: true })).toEqual({ ok: true })
    expect(existsSync(join(s1.homeDir, 'Library', 'LaunchAgents', 'com.scry.daemon.plist'))).toBe(false)
    expect(callsRunning).toEqual([])

    const callsStopped: string[][] = []
    const s2 = setup({ exec: async (_f, args) => { callsStopped.push(args); return args[0] === 'print' ? fail(113) : ok() } })
    await s2.manager.enable({ daemonRunning: false })
    callsStopped.length = 0
    expect(await s2.manager.disable({ daemonRunning: false })).toEqual({ ok: true })
    expect(callsStopped).toEqual([['bootout', 'gui/501/com.scry.daemon']])
  })

  it('reconciles moved App ONLY via explicit reconcileMovedApp (status stays read-only); never overwrites other userData, other existing app, or foreign file', async () => {
    const { root, homeDir, userDataDir, executable, appPath, resourcesPath, manager } = setup({ exec: async () => ok() })
    const agentsDir = join(homeDir, 'Library', 'LaunchAgents')
    mkdirSync(agentsDir, { recursive: true })
    const plistPath = join(agentsDir, 'com.scry.daemon.plist')

    writeFileSync(plistPath, '<plist><dict><key>Label</key><string>com.scry.daemon</string></dict></plist>')
    expect(await manager.status()).toEqual({ state: 'conflict', reason: 'login_start_foreign_service' })
    expect(await manager.enable({ daemonRunning: false })).toEqual({ ok: false, reason: 'login_start_foreign_service' })

    const otherUserData = join(root, 'other-userData')
    writeFileSync(plistPath, renderLaunchdPlist(loginStartTemplateInput({
      executable, appPath, resourcesPath, userDataDir: otherUserData, isPackaged: true
    })))
    expect(await manager.status()).toEqual({
      state: 'conflict', reason: 'login_start_other_userdata', otherUserDataDir: otherUserData
    })
    expect(await manager.enable({ daemonRunning: false })).toEqual({
      ok: false, reason: 'login_start_other_userdata', otherUserDataDir: otherUserData
    })

    const otherExec = join(root, 'Other.app', 'Contents', 'MacOS', 'Scry')
    mkdirSync(join(root, 'Other.app', 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(otherExec, '')
    const otherAppPlist = renderLaunchdPlist(loginStartTemplateInput({
      executable: otherExec, appPath: join(root, 'Other.app', 'Contents', 'Resources', 'app.asar'),
      resourcesPath: join(root, 'Other.app', 'Contents', 'Resources'), userDataDir, isPackaged: true
    }))
    writeFileSync(plistPath, otherAppPlist)
    expect(await manager.status()).toEqual({ state: 'conflict', reason: 'login_start_other_app', otherExecutable: otherExec })
    expect(await manager.enable({ daemonRunning: false })).toEqual({ ok: false, reason: 'login_start_other_app', otherExecutable: otherExec })
    expect(readFileSync(plistPath, 'utf8')).toBe(otherAppPlist)

    rmSync(otherExec)
    const movedPlist = renderLaunchdPlist(loginStartTemplateInput({
      executable: otherExec, appPath: join(root, 'Other.app', 'Contents', 'Resources', 'app.asar'),
      resourcesPath: join(root, 'Other.app', 'Contents', 'Resources'), userDataDir, isPackaged: true
    }, { policyEnv: [['SCRY_REMOTE_HOST', '1']] }))
    writeFileSync(plistPath, movedPlist)
    await manager.status()
    expect(readFileSync(plistPath, 'utf8')).toBe(movedPlist)
    expect(manager.reconcileMovedApp()).toEqual({ rewritten: true, fromExecutable: otherExec })
    expect(readFileSync(plistPath, 'utf8')).toContain(executable)
    expect(await manager.status()).toMatchObject({
      state: 'enabled',
      loaded: true,
      rewrittenFromExecutable: otherExec,
      policyEnv: [{ key: 'SCRY_REMOTE_HOST', value: '1' }]
    })
  })

  it('Linux enable, status (Key=Value show + Linger), startViaService (daemon-reload + start), and disable (no stop)', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const { homeDir, manager } = setup({
      platform: 'linux',
      allowLinux: true,
      systemctlAvailable: true,
      exec: async (file, args) => {
        calls.push({ file, args })
        if (file === '/usr/bin/systemctl' && args[1] === 'show') return ok('MainPID=9876\nActiveState=active\n')
        if (file === '/usr/bin/loginctl') return ok('no\n')
        return ok()
      }
    })
    expect(await manager.enable({ daemonRunning: false })).toEqual({ ok: true })
    expect(calls).toEqual([
      { file: '/usr/bin/systemctl', args: ['--user', 'daemon-reload'] },
      { file: '/usr/bin/systemctl', args: ['--user', 'enable', 'scry-daemon.service'] },
      { file: '/usr/bin/systemctl', args: ['--user', 'start', 'scry-daemon.service'] }
    ])
    const unitPath = join(homeDir, '.config', 'systemd', 'user', 'scry-daemon.service')
    expect(existsSync(unitPath)).toBe(true)

    calls.length = 0
    expect(await manager.status()).toEqual({
      state: 'enabled',
      loaded: true,
      policyEnv: [],
      linuxLinger: 'no',
      linuxMainPid: 9876
    })
    expect(calls).toContainEqual({ file: '/usr/bin/systemctl', args: ['--user', 'show', '-p', 'ActiveState,MainPID', 'scry-daemon.service'] })

    calls.length = 0
    expect(await manager.startViaService()).toEqual({ ok: true })
    expect(calls).toEqual([
      { file: '/usr/bin/systemctl', args: ['--user', 'daemon-reload'] },
      { file: '/usr/bin/systemctl', args: ['--user', 'start', 'scry-daemon.service'] }
    ])

    calls.length = 0
    expect(await manager.disable({ daemonRunning: true })).toEqual({ ok: true })
    expect(existsSync(unitPath)).toBe(false)
    expect(calls).toEqual([
      { file: '/usr/bin/systemctl', args: ['--user', 'disable', 'scry-daemon.service'] },
      { file: '/usr/bin/systemctl', args: ['--user', 'daemon-reload'] }
    ])
  })

  it('macOS startViaService checks print, reloads idle definition via bootout + bootstrap, and reports exit code on failure (S3)', async () => {
    const idlePrint = 'gui/501/com.scry.daemon = {\n\tstate = not running\n}\n'
    const fn = vi.fn<CommandRunner>(async (_file, args) => {
      if (args[0] === 'print') return ok(idlePrint)
      return args[0] === 'bootstrap' ? fail(125) : ok()
    })
    const s = setup({ exec: fn })
    const plistPath = join(s.homeDir, 'Library', 'LaunchAgents', 'com.scry.daemon.plist')
    mkdirSync(join(s.homeDir, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(plistPath, renderLaunchdPlist(loginStartTemplateInput({
      executable: s.executable, appPath: s.appPath, resourcesPath: s.resourcesPath, userDataDir: s.userDataDir, isPackaged: true
    })), { mode: 0o600 })
    expect(await s.manager.startViaService()).toEqual({
      ok: false, reason: 'login_start_service_launch_failed', exitCode: 125
    })
    expect(fn.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['/bin/launchctl', ['print', 'gui/501/com.scry.daemon']],
      ['/bin/launchctl', ['bootout', 'gui/501/com.scry.daemon']],
      ['/bin/launchctl', ['bootstrap', 'gui/501', plistPath]]
    ])
  })
})
