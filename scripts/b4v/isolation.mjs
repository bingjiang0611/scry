// Isolation assertions for the B4-V scripts. A scenario acts only after these hold: the
// paths it will hand the App are inside its own temporary root, and the daemon (or, with
// the switch off, the App) that actually opened scry.db holds the locks *in that root*.
// The live check is made from facts the caller collected; this module only judges them,
// so the judgement is testable without a running App.
import { isAbsolute, join, relative, sep } from 'node:path'

// sockaddr_un.sun_path: 104 bytes on macOS, 108 on Linux, including the terminator.
export const SOCKET_PATH_LIMIT = Object.freeze({ darwin: 104, linux: 108 })

export function isWithin(child, parent) {
  if (!isAbsolute(child) || !isAbsolute(parent)) return false
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/** Where a real Scry keeps its userData; a temporary root must never be inside one. */
export function realUserDataCandidates({ platform = process.platform, home, xdgConfigHome } = {}) {
  if (!home) return []
  if (platform === 'darwin') return ['Scry', 'scry'].map((name) => join(home, 'Library', 'Application Support', name))
  const config = xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(home, '.config')
  return ['Scry', 'scry'].map((name) => join(config, name))
}

export function daemonStateDirectory(userDataDir) {
  return join(userDataDir, 'daemon')
}

/**
 * Before anything is launched. Every input path is expected to be canonical already
 * (the fixture realpaths its root), so this is a pure comparison.
 */
export function staticIsolation({ tempRoot, userDataDir, home, workspace, realHome, platform = process.platform, xdgConfigHome }) {
  const checks = []
  const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail })
  for (const [name, path] of Object.entries({ userDataDir, home, workspace })) {
    check(`${name}-inside-temp-root`, typeof path === 'string' && isWithin(path, tempRoot) && path !== tempRoot, path)
  }
  check('workspace-inside-fixture-home', isWithin(workspace, home), { workspace, home })
  check('temp-root-not-in-real-home', !realHome || !isWithin(tempRoot, realHome), { tempRoot, realHome })
  const real = realUserDataCandidates({ platform, home: realHome, xdgConfigHome })
  check('temp-root-not-real-userdata', real.every((candidate) => !isWithin(tempRoot, candidate) && !isWithin(candidate, tempRoot)), real)
  check('fixture-home-is-not-real-home', home !== realHome, { home, realHome })
  const limit = SOCKET_PATH_LIMIT[platform] ?? 104
  const socket = join(daemonStateDirectory(userDataDir), 'local.sock')
  const bytes = Buffer.byteLength(socket)
  check('socket-path-fits', bytes < limit, { socket, bytes, limit })
  return { ok: checks.every((item) => item.ok), checks }
}

/**
 * After the App is ready, before the scenario acts. `facts` is what the caller read:
 *   daemonLock / userDataLock   parsed lock records (or null)
 *   daemonHolder                verifyHolder() verdict for daemonLock
 *   daemonEnv                   readProcessEnv() result for the daemon pid
 *   dbExists                    whether <userData>/scry.db exists
 *   appPid                      the App main pid this script spawned
 */
export function liveIsolation({ mode, userDataDir, facts }) {
  const checks = []
  const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail })
  check('db-in-temp-userdata', facts.dbExists === true, join(userDataDir, 'scry.db'))
  if (mode === 'daemon') {
    check('daemon-lock-in-temp-userdata', Boolean(facts.daemonLock && !facts.daemonLock.unreadable), join(daemonStateDirectory(userDataDir), 'daemon.lock'))
    check('daemon-lock-holder-verified', facts.daemonHolder === 'verified', facts.daemonHolder)
    check('userdata-lock-held-by-daemon',
      facts.userDataLock?.pid === facts.daemonLock?.pid && facts.userDataLock?.role === 'daemon' &&
      facts.userDataLock?.identityKey === facts.daemonLock?.identityKey,
      { userDataLock: facts.userDataLock ?? null, daemonPid: facts.daemonLock?.pid ?? null })
    if (facts.daemonEnv?.status === 'available') {
      check('daemon-env-names-temp-userdata', facts.daemonEnv.env.SCRY_DAEMON_USER_DATA_DIR === userDataDir &&
        facts.daemonEnv.env.SCRY_DAEMON_STATE_DIR === daemonStateDirectory(userDataDir), facts.daemonEnv.env)
    } else {
      // The locks above already prove the daemon writes here; the environment is extra
      // evidence, recorded as unavailable instead of being assumed.
      checks.push({ id: 'daemon-env-names-temp-userdata', ok: true, unavailable: true, detail: facts.daemonEnv ?? null })
    }
  } else {
    check('no-daemon-lock', !facts.daemonLock, facts.daemonLock ?? null)
    check('userdata-lock-held-by-app', facts.userDataLock?.pid === facts.appPid && facts.userDataLock?.role === 'app',
      { userDataLock: facts.userDataLock ?? null, appPid: facts.appPid })
  }
  return { ok: checks.every((item) => item.ok), checks }
}

/** Files that must not outlive a stopped daemon and App (P3-userdata-lock, leases). */
export function leftoverPaths(userDataDir) {
  const state = daemonStateDirectory(userDataDir)
  return [
    join(state, 'daemon.lock'),
    join(state, 'local.sock'),
    join(state, 'enroll.sock'),
    join(userDataDir, 'scry-userdata.lock'),
    join(userDataDir, 'remote', 'pairing', 'pairing-state.lock'),
    join(userDataDir, 'remote', 'ledger', 'session-ledger.lock'),
    join(userDataDir, 'remote', 'output', 'run-output.lock')
  ]
}
