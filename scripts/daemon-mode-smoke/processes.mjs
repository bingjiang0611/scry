// Which binary and which entry the daemon and its supervisor really run, read from the
// live processes (scripts/b4v/process-identity.mjs) rather than inferred from the App's
// configuration. The daemon is found through the lock it wrote and verified against the
// identity recorded there; the supervisor must be the daemon's parent and the one the
// lock names. Nothing is signalled here.
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  readIdentity, readLaunch, readLockRecord, readProcessEnv, supervisorPidFromLock, verifyHolder
} from '../b4v/process-identity.mjs'

export const DAEMON_ENV_KEYS = Object.freeze([
  'ELECTRON_RUN_AS_NODE', 'SCRY_DAEMON_PACKAGED', 'SCRY_DAEMON_APP_PATH', 'SCRY_DAEMON_RESOURCES_PATH', 'SCRY_DAEMON_STATE_DIR'
])

const realOr = (path, realpath) => {
  if (typeof path !== 'string' || path.length === 0) return path
  try { return realpath(path) } catch { return path }
}

/**
 * One process against the target: the executable image, the entry it was started with
 * and the environment the App gave it. Every mismatch is listed; any one fails the step.
 */
export function checkDaemonLaunch({ role, launch, env, target, stateDirectory, realpath = realpathSync }) {
  const entry = join(target.entryDirectory, role === 'daemon' ? 'daemon.js' : 'daemon-supervisor.js')
  const failures = []
  if (launch?.status !== 'available') return { ok: false, role, failures: [`launch_unavailable:${launch?.reason ?? 'unknown'}`] }
  const image = realOr(launch.executable, realpath)
  if (image !== target.executable) failures.push('executable_mismatch')
  // Linux gives the exact argv; macOS only a space-joined command, compared whole.
  const entryMatches = Array.isArray(launch.argv)
    ? launch.argv.length === 2 && launch.argv[1] === entry
    : launch.command === `${launch.executable} ${entry}`
  if (!entryMatches) failures.push('entry_mismatch')
  if (env?.status !== 'available') {
    failures.push(`environment_unavailable:${env?.reason ?? 'unknown'}`)
  } else {
    const values = env.env
    if (values.ELECTRON_RUN_AS_NODE !== '1') failures.push('not_run_as_node')
    if (values.SCRY_DAEMON_PACKAGED !== (target.packaged ? '1' : '0')) failures.push('packaged_flag_mismatch')
    if (values.SCRY_DAEMON_APP_PATH !== (target.packaged ? target.appArchive : target.appPath)) failures.push('app_path_mismatch')
    if (target.packaged && realOr(values.SCRY_DAEMON_RESOURCES_PATH, realpath) !== target.resources) failures.push('resources_mismatch')
    if (realOr(values.SCRY_DAEMON_STATE_DIR, realpath) !== realOr(stateDirectory, realpath)) failures.push('state_directory_mismatch')
  }
  return {
    ok: failures.length === 0, role, executable: image, entry: Array.isArray(launch.argv) ? launch.argv[1] : launch.command,
    ...(failures.length ? { expected: { executable: target.executable, entry }, failures } : {})
  }
}

export function daemonProcessEvidence(stateDirectory, target, probes = {}) {
  const identityOf = probes.readIdentity ?? readIdentity
  const launchOf = probes.readLaunch ?? readLaunch
  const envOf = probes.readProcessEnv ?? readProcessEnv
  const lock = (probes.readLockRecord ?? readLockRecord)(join(stateDirectory, 'daemon.lock'))
  if (!lock || lock.unreadable) return { ok: false, reason: lock ? 'daemon_lock_unreadable' : 'daemon_lock_missing' }
  const daemon = identityOf(lock.pid)
  const verdict = verifyHolder(lock, daemon)
  if (verdict !== 'verified') return { ok: false, reason: `daemon_holder_${verdict}`, pid: lock.pid }
  const supervisorPid = supervisorPidFromLock(lock)
  if (supervisorPid === undefined) return { ok: false, reason: 'daemon_not_started_by_supervisor', startedBy: lock.startedBy ?? null }
  if (daemon.ppid !== supervisorPid) return { ok: false, reason: 'supervisor_not_daemon_parent', supervisorPid, ppid: daemon.ppid }
  if (!identityOf(supervisorPid)) return { ok: false, reason: 'supervisor_gone', supervisorPid }
  const resources = envOf(lock.pid, DAEMON_ENV_KEYS)
  const checks = [['daemon', lock.pid], ['supervisor', supervisorPid]].map(([role, pid]) => ({
    pid, ...checkDaemonLaunch({ role, launch: launchOf(pid), env: role === 'daemon' ? resources : envOf(pid, DAEMON_ENV_KEYS), target, stateDirectory, realpath: probes.realpath })
  }))
  return {
    ok: checks.every((check) => check.ok),
    daemon: checks[0], supervisor: checks[1],
    // The resources directory the daemon was given, for the private CLI step.
    daemonResources: resources.status === 'available' ? resources.env.SCRY_DAEMON_RESOURCES_PATH ?? null : null
  }
}
