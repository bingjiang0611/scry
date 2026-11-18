// One isolated fixture per scenario: a temporary root under /tmp (unix socket paths have a
// hard length limit, and macOS' TMPDIR is long), with userData, HOME and a workspace
// inside it. The fixture also owns the daemon lifecycle questions a scenario asks:
// who holds the locks, which processes carry this fixture's state directory, and how to
// stop them without touching anything that is not provably this fixture's.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { daemonStateDirectory, leftoverPaths, liveIsolation, staticIsolation } from './isolation.mjs'
import {
  classifyDaemonCommand, descendants, listProcesses, processesWithEnv, readIdentity, readLockRecord,
  readProcessEnv, signalVerified, supervisorPidFromLock, verifyHolder, waitGone
} from './process-identity.mjs'

export function createFixture(label, { baseDir = '/tmp' } = {}) {
  if (!/^[a-z0-9-]{1,24}$/.test(label)) throw new Error(`fixture label must be short kebab-case: ${label}`)
  const tempRoot = realpathSync(mkdtempSync(join(baseDir, `scry-b4v-${label}-`)))
  const userDataDir = join(tempRoot, 'userData')
  const home = join(tempRoot, 'home')
  const workspace = join(home, 'workspace')
  const logs = join(tempRoot, 'logs')
  for (const directory of [userDataDir, workspace, logs]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# b4v fixture\n')
  // The App only starts runs in a directory its own picker recorded; in an isolated
  // userData the project list is the only place that proof can come from.
  writeFileSync(join(userDataDir, 'projects.json'), JSON.stringify([{ cwd: workspace, lastOpenedAt: 1 }]))
  const fixture = {
    label, tempRoot, userDataDir, home, workspace, logs,
    daemonState: daemonStateDirectory(userDataDir),
    ownedIdentities: [],
    keep: false
  }
  fixture.staticIsolation = staticIsolation({ tempRoot, userDataDir, home, workspace, realHome: homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME })
  return fixture
}

export const daemonLockPath = (fixture) => join(fixture.daemonState, 'daemon.lock')
export const userDataLockPath = (fixture) => join(fixture.userDataDir, 'scry-userdata.lock')
export const daemonLogPath = (fixture) => join(fixture.userDataDir, 'logs', 'daemon.log')

/** The daemon that holds this fixture's state lock, verified against its recorded identity. */
export function daemonHolder(fixture) {
  const lock = readLockRecord(daemonLockPath(fixture))
  if (!lock || lock.unreadable) return { lock, verdict: lock ? 'unreadable' : 'no-lock', identity: undefined }
  const identity = readIdentity(lock.pid)
  return { lock, verdict: verifyHolder(lock, identity), identity }
}

export async function waitForDaemonHolder(fixture, { timeoutMs = 60_000, differentFrom } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = daemonHolder(fixture)
    if (last.verdict === 'verified' && existsSync(join(fixture.daemonState, 'local.sock')) &&
        (!differentFrom || last.lock.identityKey !== differentFrom.identityKey)) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return last
}

/** This fixture's supervisor and daemon processes, found by the state directory they were given. */
export function fixtureDaemonProcesses(fixture) {
  const found = processesWithEnv('SCRY_DAEMON_STATE_DIR', fixture.daemonState)
  if (found.status !== 'available') return found
  const byKind = { daemon: [], supervisor: [], other: [] }
  for (const row of found.rows) byKind[classifyDaemonCommand(row.command)].push(row)
  return { status: 'available', ...byKind }
}

export function collectLiveIsolation(fixture, { mode, appPid }) {
  const holder = daemonHolder(fixture)
  const facts = {
    dbExists: existsSync(join(fixture.userDataDir, 'scry.db')),
    daemonLock: holder.lock,
    daemonHolder: holder.verdict,
    userDataLock: readLockRecord(userDataLockPath(fixture)),
    daemonEnv: holder.verdict === 'verified'
      ? readProcessEnv(holder.lock.pid, ['SCRY_DAEMON_USER_DATA_DIR', 'SCRY_DAEMON_STATE_DIR'])
      : undefined,
    appPid
  }
  return { ...liveIsolation({ mode, userDataDir: fixture.userDataDir, facts }), facts }
}

/** Remember an identity this scenario created (a pty, a daemon it launched) for cleanup. */
export function own(fixture, identity, role) {
  if (identity?.pid && identity.identityKey) fixture.ownedIdentities.push({ ...identity, role })
}

/**
 * Stop this fixture's daemon: SIGTERM the supervisor that is the parent of the verified
 * lock holder (it aborts the daemon), or the holder itself when no supervisor started it.
 * Every signal re-verifies identity first; SIGKILL is the bounded fallback.
 */
export async function stopFixtureDaemon(fixture, { timeoutMs = 15_000 } = {}) {
  const evidence = { holder: null, signals: [], remaining: [] }
  const holder = daemonHolder(fixture)
  evidence.holder = { verdict: holder.verdict, pid: holder.lock?.pid ?? null, startedBy: holder.lock?.startedBy ?? null }
  const targets = []
  if (holder.verdict === 'verified') {
    targets.push(holder.identity)
    const supervisorPid = supervisorPidFromLock(holder.lock)
    const supervisor = supervisorPid === holder.identity.ppid ? readIdentity(supervisorPid) : undefined
    if (supervisor && classifyDaemonCommand(supervisor.command) === 'supervisor') targets.unshift(supervisor)
  }
  // Processes that carry this fixture's state directory but hold no lock (a supervisor
  // between restarts, a daemon that has not taken the lock yet) are this fixture's too.
  const carried = fixtureDaemonProcesses(fixture)
  if (carried.status === 'available') {
    for (const row of [...carried.supervisor, ...carried.daemon]) if (!targets.some((target) => target.pid === row.pid)) targets.push(row)
  } else {
    evidence.processScan = carried
  }
  // A scenario may have frozen the daemon (SIGSTOP); a stopped process does not act on SIGTERM.
  for (const target of targets) signalVerified(target, 'SIGCONT')
  for (const target of targets) evidence.signals.push({ pid: target.pid, signal: 'SIGTERM', ...signalVerified(target, 'SIGTERM') })
  let remaining = await waitGone(targets, timeoutMs)
  for (const target of remaining) evidence.signals.push({ pid: target.pid, signal: 'SIGKILL', ...signalVerified(target, 'SIGKILL') })
  if (remaining.length > 0) remaining = await waitGone(remaining, 5_000)
  evidence.remaining = remaining.map(({ pid, command }) => ({ pid, command: command.slice(0, 200) }))
  return evidence
}

/** Kill identities the scenario recorded (ptys, launched daemons) that are still alive. */
export async function reapOwned(fixture) {
  const alive = fixture.ownedIdentities.filter((identity) => verifyHolder(identity, readIdentity(identity.pid)) === 'verified')
  const signals = alive.map((identity) => ({ pid: identity.pid, role: identity.role, ...signalVerified(identity, 'SIGKILL') }))
  const remaining = await waitGone(alive, 5_000)
  return { signals, remaining: remaining.map(({ pid, role }) => ({ pid, role })) }
}

/** What is left of this fixture after its App and daemon were stopped. */
export function fixtureLeftovers(fixture) {
  const files = leftoverPaths(fixture.userDataDir).filter((path) => existsSync(path))
  const processes = fixtureDaemonProcesses(fixture)
  const owned = fixture.ownedIdentities.filter((identity) => verifyHolder(identity, readIdentity(identity.pid)) === 'verified')
  return {
    files,
    processes: processes.status === 'available'
      ? { status: 'available', live: [...processes.daemon, ...processes.supervisor, ...processes.other].map(({ pid, command }) => ({ pid, command: command.slice(0, 200) })) }
      : processes,
    owned: owned.map(({ pid, role }) => ({ pid, role }))
  }
}

export function disposeFixture(fixture, { keep }) {
  if (keep || fixture.keep) return { removed: false, kept: fixture.tempRoot }
  rmSync(fixture.tempRoot, { recursive: true, force: true })
  return { removed: !existsSync(fixture.tempRoot) }
}

/** Tail of the daemon log for evidence; the supervisor discards daemon stdout otherwise. */
export function daemonLogTail(fixture, bytes = 4_000) {
  try {
    const text = readFileSync(daemonLogPath(fixture), 'utf8')
    return text.slice(-bytes)
  } catch {
    return null
  }
}

/** Every process descended from the App main, minus this fixture's daemon tree. */
export function appOwnedProcesses(appPid, fixture) {
  const rows = listProcesses()
  const appTree = descendants(rows, appPid)
  const root = rows.find((row) => row.pid === appPid)
  const holder = daemonHolder(fixture)
  const excluded = new Set()
  const exclude = (pid) => { excluded.add(pid); for (const row of descendants(rows, pid)) excluded.add(row.pid) }
  if (holder.verdict === 'verified') {
    exclude(holder.lock.pid)
    const supervisorPid = supervisorPidFromLock(holder.lock)
    if (supervisorPid) exclude(supervisorPid)
  }
  for (const row of appTree) if (classifyDaemonCommand(row.command) !== 'other') exclude(row.pid)
  return [...(root ? [root] : []), ...appTree.filter((row) => !excluded.has(row.pid))]
}
