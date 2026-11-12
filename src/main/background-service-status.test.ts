import { describe, expect, it } from 'vitest'
import { connectionFromMode, parseSelfReport, readBackgroundServiceStatus, type BackgroundServiceStatusDeps } from './background-service-status'
import { readProcessIdentity, readProcessIdentitySync } from './process-diagnostics'

// What the «后台服务» section is told. A value the App could not establish stays null;
// a daemon that did not answer never reads as "0 devices" or "no runs".

const report = { version: '1.2.3', pid: 4242, startedAt: 1_700_000_000_000, devices: { state: 'known', paired: 2 }, activeRuns: 1 }

function deps(extra: Partial<BackgroundServiceStatusDeps> = {}): BackgroundServiceStatusDeps {
  return {
    daemonMode: true,
    userDataDir: '/u',
    connection: async () => ({ state: 'ready' }),
    selfReport: async () => report,
    lockHolder: async () => ({ pid: 4242 }),
    now: () => 99,
    ...extra
  }
}

describe('background service status', () => {
  it('says there is no background service with the switch off', async () => {
    await expect(readBackgroundServiceStatus(deps({ daemonMode: false }))).resolves.toEqual({ mode: 'in-process', userDataDir: '/u' })
  })

  it('takes version, pid, uptime, paired devices and runs from the daemon while connected', async () => {
    await expect(readBackgroundServiceStatus(deps())).resolves.toEqual({
      mode: 'daemon', userDataDir: '/u', connection: { state: 'ready' }, checkedAt: 99,
      version: '1.2.3', pid: 4242, startedAt: 1_700_000_000_000, devices: { state: 'known', paired: 2 }, activeRuns: 1
    })
  })

  it('keeps every daemon-owned value unknown when the daemon cannot be asked', async () => {
    const status = await readBackgroundServiceStatus(deps({
      connection: async () => ({ state: 'device-not-authorized' }),
      selfReport: async () => { throw new Error('must not be asked') }
    }))
    expect(status).toMatchObject({ connection: { state: 'device-not-authorized' }, version: null, pid: 4242, startedAt: null, devices: null, activeRuns: null })
  })

  it('shows the running version a mismatched daemon named, and nothing it did not', async () => {
    const named = await readBackgroundServiceStatus(deps({ connection: async () => ({ state: 'version-mismatch', running: '1.0.0', expected: '2.0.0' }) }))
    expect(named).toMatchObject({ version: '1.0.0', activeRuns: null, devices: null })
    const unnamed = await readBackgroundServiceStatus(deps({
      connection: async () => ({ state: 'version-mismatch', running: null, expected: '2.0.0' }),
      lockHolder: async () => undefined
    }))
    expect(unnamed).toMatchObject({ version: null, pid: null })
  })

  it('treats a malformed daemon answer as unknown instead of filling zeros', async () => {
    for (const bad of [null, {}, { ...report, activeRuns: -1 }, { ...report, devices: { state: 'known' } }, { ...report, pid: 1 }, { ...report, devices: { state: 'remote-disabled', paired: 3 } }]) {
      const status = await readBackgroundServiceStatus(deps({ selfReport: async () => bad }))
      expect(status).toMatchObject({ version: null, devices: null, activeRuns: null, pid: 4242 })
    }
    expect(parseSelfReport({ ...report, devices: { state: 'remote-disabled' } })?.devices).toEqual({ state: 'remote-disabled' })
  })

  it('maps every connection outcome, with its reason', () => {
    expect(connectionFromMode({ status: 'ready' }, '2')).toEqual({ state: 'ready' })
    expect(connectionFromMode({ status: 'version-mismatch', running: 'unknown', expected: '2' }, '2')).toEqual({ state: 'version-mismatch', running: null, expected: '2' })
    expect(connectionFromMode({ status: 'device-not-authorized', reason: 'daemon_device_not_authorized' }, '2')).toEqual({ state: 'device-not-authorized' })
    expect(connectionFromMode({ status: 'unavailable', reason: 'daemon_ready_timeout' }, '2')).toEqual({ state: 'unavailable', reason: 'daemon_ready_timeout' })
    expect(connectionFromMode({ status: 'credential-unavailable', reason: 'unsafe_credential_storage' }, '2'))
      .toEqual({ state: 'unavailable', reason: 'daemon_credential_unavailable:unsafe_credential_storage' })
  })

  it('shows the build next to a version that is the same on both sides (A5)', () => {
    const old = '3b04ee8'.padEnd(64, 'a')
    const current = '0bf3e97'.padEnd(64, 'b')
    expect(connectionFromMode({ status: 'version-mismatch', running: '0.2.237', runningBuild: old, expected: '0.2.237', expectedBuild: current }, '0.2.237'))
      .toEqual({ state: 'version-mismatch', running: '0.2.237 (3b04ee8)', expected: '0.2.237 (0bf3e97)' })
    // A daemon from before build ids says only its version.
    expect(connectionFromMode({ status: 'version-mismatch', running: '0.2.237', expected: '0.2.237', expectedBuild: current }, '0.2.237'))
      .toEqual({ state: 'version-mismatch', running: '0.2.237 (构建号未知)', expected: '0.2.237 (0bf3e97)' })
    // Control: different versions stay plain versions; the build adds nothing there.
    expect(connectionFromMode({ status: 'version-mismatch', running: '0.2.236', runningBuild: old, expected: '0.2.237', expectedBuild: current }, '0.2.237'))
      .toEqual({ state: 'version-mismatch', running: '0.2.236', expected: '0.2.237' })
  })
})

describe('readProcessIdentity', () => {
  it('reads the same identity key as the synchronous reader that writes daemon.lock', async () => {
    const files: Record<string, string> = {
      '/proc/7/stat': '7 (Scry Helper) S 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0',
      '/proc/sys/kernel/random/boot_id': 'boot-a\n',
      '/proc/7/cmdline': 'Scry\0out/main/daemon.js\0'
    }
    const sync = readProcessIdentitySync(7, { platform: 'linux', readFile: (path) => { const value = files[path]; if (value === undefined) throw new Error('ENOENT'); return value } })
    const async = await readProcessIdentity(7, { platform: 'linux', readFile: async (path) => { const value = files[path]; if (value === undefined) throw new Error('ENOENT'); return value } })
    expect(async).toEqual(sync)
    expect(async?.identityKey).toBe('7:linux:boot-a:12345')
    await expect(readProcessIdentity(8, { platform: 'linux', readFile: async () => { throw new Error('ENOENT') } })).resolves.toBeUndefined()
    const ps = '  7     1 Ss   Mon Nov 10 08:00:00 2026     /Applications/Scry.app/Contents/MacOS/Scry out/main/daemon.js\n'
    const mac = await readProcessIdentity(7, { platform: 'darwin', ps: async () => ps })
    expect(mac).toEqual(readProcessIdentitySync(7, { platform: 'darwin', ps: () => ps }))
  })

  it('reads this very process like the synchronous reader on this platform', async () => {
    // The state column moves (running vs sleeping); the identity must not.
    const [async, sync] = [await readProcessIdentity(process.pid), readProcessIdentitySync(process.pid)]
    expect(async && { key: async.identityKey ?? async.startedAt, command: async.command }).toEqual(sync && { key: sync.identityKey ?? sync.startedAt, command: sync.command })
    expect(async).toBeDefined()
  })
})
