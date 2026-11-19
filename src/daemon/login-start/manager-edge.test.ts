import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoginStartManager, loginStartTemplateInput, runFixedCommand, type CommandResult, type CommandRunner } from './index'
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
    daemonMode: true,
    allowLinux: options.allowLinux ?? false,
    systemctlAvailable: true,
    target: { executable, appPath, resourcesPath, userDataDir, isPackaged: true },
    env: options.env ?? {},
    runner
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

  it('refuses ephemeral macOS DMG / AppTranslocation paths and distinguishes EACCES read errors', async () => {
    const dmg = makeSetup({ executableOverride: '/Volumes/Scry/Scry.app/Contents/MacOS/Scry' })
    expect(dmg.manager.availability()).toEqual({ ok: false, reason: 'login_start_ephemeral_app_path' })
    expect(await dmg.manager.status()).toEqual({ state: 'unavailable', reason: 'login_start_ephemeral_app_path' })

    if (process.getuid?.() !== 0) {
      const s = makeSetup()
      mkdirSync(join(s.homeDir, 'Library', 'LaunchAgents'), { recursive: true })
      writeFileSync(s.manager.filePath, 'unreadable', { mode: 0o000 })
      try {
        expect(await s.manager.status()).toEqual({ state: 'unavailable', reason: 'login_start_read_failed:EACCES' })
        expect(await s.manager.enable({ daemonRunning: false })).toEqual({ ok: false, reason: 'login_start_read_failed:EACCES' })
      } finally {
        chmodSync(s.manager.filePath, 0o600)
      }
    }
  })

  it('runFixedCommand reports real execFile timeout and missing binary (S8)', async () => {
    const missing = await runFixedCommand('/nonexistent/scry-no-such-binary-xyz', [], 1_000)
    expect(missing).toEqual({ exitCode: null, stdout: '', timedOut: false, notFound: true })

    const timedOut = await runFixedCommand('/bin/sleep', ['5'], 120)
    expect(timedOut.timedOut).toBe(true)
    expect(timedOut.exitCode).not.toBe(0)
  })
})
