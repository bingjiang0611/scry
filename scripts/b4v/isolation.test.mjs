import { describe, expect, it } from 'vitest'
import { isWithin, leftoverPaths, liveIsolation, realUserDataCandidates, staticIsolation } from './isolation.mjs'

const root = '/tmp/scry-b4v-x-abc123'
const paths = { tempRoot: root, userDataDir: `${root}/userData`, home: `${root}/home`, workspace: `${root}/home/workspace` }

describe('b4v isolation', () => {
  it('compares canonical paths without prefix confusion', () => {
    expect(isWithin('/tmp/a/b', '/tmp/a')).toBe(true)
    expect(isWithin('/tmp/a', '/tmp/a')).toBe(true)
    expect(isWithin('/tmp/ab', '/tmp/a')).toBe(false)
    expect(isWithin('/tmp/a/../b', '/tmp/a')).toBe(false)
    expect(isWithin('relative', '/tmp')).toBe(false)
  })

  it('accepts a fixture under /tmp and names the real userData it stays out of', () => {
    const result = staticIsolation({ ...paths, realHome: '/Users/dev', platform: 'darwin' })
    expect(result.ok).toBe(true)
    expect(realUserDataCandidates({ platform: 'darwin', home: '/Users/dev' })).toContain('/Users/dev/Library/Application Support/Scry')
    expect(realUserDataCandidates({ platform: 'linux', home: '/home/dev' })).toContain('/home/dev/.config/Scry')
    expect(realUserDataCandidates({ platform: 'linux', home: '/home/dev', xdgConfigHome: '/x/cfg' })).toContain('/x/cfg/Scry')
  })

  it('refuses a fixture whose root is inside the real HOME or whose paths escape it', () => {
    const inHome = staticIsolation({ tempRoot: '/Users/dev/tmp/r', userDataDir: '/Users/dev/tmp/r/userData', home: '/Users/dev/tmp/r/home',
      workspace: '/Users/dev/tmp/r/home/workspace', realHome: '/Users/dev', platform: 'darwin' })
    expect(inHome.ok).toBe(false)
    expect(inHome.checks.find((check) => check.id === 'temp-root-not-in-real-home').ok).toBe(false)
    const escaped = staticIsolation({ ...paths, userDataDir: '/Users/dev/Library/Application Support/Scry', realHome: '/Users/dev', platform: 'darwin' })
    expect(escaped.checks.find((check) => check.id === 'userDataDir-inside-temp-root').ok).toBe(false)
    const realHome = staticIsolation({ ...paths, home: root, realHome: root, platform: 'linux' })
    expect(realHome.ok).toBe(false)
  })

  it('refuses a socket path the platform cannot bind', () => {
    const long = `/tmp/${'x'.repeat(80)}`
    const result = staticIsolation({ tempRoot: long, userDataDir: `${long}/userData`, home: `${long}/home`, workspace: `${long}/home/workspace`,
      realHome: '/Users/dev', platform: 'darwin' })
    expect(result.checks.find((check) => check.id === 'socket-path-fits').ok).toBe(false)
  })

  const daemonLock = { pid: 42, identityKey: '42:linux:boot:1', role: 'daemon' }
  const env = { status: 'available', env: { SCRY_DAEMON_USER_DATA_DIR: paths.userDataDir, SCRY_DAEMON_STATE_DIR: `${paths.userDataDir}/daemon` } }

  it('daemon mode: the verified daemon must hold both locks in the temp userData', () => {
    const facts = { dbExists: true, daemonLock, daemonHolder: 'verified', userDataLock: { ...daemonLock }, daemonEnv: env }
    expect(liveIsolation({ mode: 'daemon', userDataDir: paths.userDataDir, facts }).ok).toBe(true)
    expect(liveIsolation({ mode: 'daemon', userDataDir: paths.userDataDir, facts: { ...facts, dbExists: false } }).ok).toBe(false)
    expect(liveIsolation({ mode: 'daemon', userDataDir: paths.userDataDir, facts: { ...facts, daemonHolder: 'pid-reused' } }).ok).toBe(false)
    expect(liveIsolation({ mode: 'daemon', userDataDir: paths.userDataDir, facts: { ...facts, userDataLock: { ...daemonLock, pid: 7 } } }).ok).toBe(false)
    const elsewhere = { status: 'available', env: { ...env.env, SCRY_DAEMON_USER_DATA_DIR: '/Users/dev/Library/Application Support/Scry' } }
    expect(liveIsolation({ mode: 'daemon', userDataDir: paths.userDataDir, facts: { ...facts, daemonEnv: elsewhere } }).ok).toBe(false)
    // An unreadable environment is recorded as unavailable; the locks still decide.
    const unavailable = liveIsolation({ mode: 'daemon', userDataDir: paths.userDataDir, facts: { ...facts, daemonEnv: { status: 'unavailable' } } })
    expect(unavailable.ok).toBe(true)
    expect(unavailable.checks.find((check) => check.id === 'daemon-env-names-temp-userdata').unavailable).toBe(true)
  })

  it('switch-off: the App holds scry-userdata.lock and no daemon lock exists', () => {
    const facts = { dbExists: true, daemonLock: null, userDataLock: { pid: 9, role: 'app' }, appPid: 9 }
    expect(liveIsolation({ mode: 'switch-off', userDataDir: paths.userDataDir, facts }).ok).toBe(true)
    expect(liveIsolation({ mode: 'switch-off', userDataDir: paths.userDataDir, facts: { ...facts, daemonLock } }).ok).toBe(false)
    expect(liveIsolation({ mode: 'switch-off', userDataDir: paths.userDataDir, facts: { ...facts, appPid: 10 } }).ok).toBe(false)
  })

  it('lists the lock, socket and lease files a stopped host must not leave', () => {
    const files = leftoverPaths('/u')
    expect(files).toEqual(expect.arrayContaining(['/u/daemon/daemon.lock', '/u/scry-userdata.lock', '/u/daemon/local.sock',
      '/u/remote/ledger/session-ledger.lock', '/u/remote/pairing/pairing-state.lock', '/u/remote/output/run-output.lock']))
  })
})
