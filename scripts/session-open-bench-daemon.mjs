// Daemon lifecycle for `session-open-bench.mjs --daemon`. Loaded only in daemon mode, so
// the default (gated) bench never imports the B4-V helpers it relies on.
//
// The App launches the supervisor detached, and the supervisor launches the daemon; both
// outlive the App by design. This bench caused them, so it stops them itself, by the
// identity their state directory records (daemon.lock pid + start time) and by the
// SCRY_DAEMON_STATE_DIR their environment carries, re-verifying every identity right
// before each signal (scripts/b4v/fixture.mjs stopFixtureDaemon). Never by name.
import { daemonHolder, daemonLogTail, fixtureDaemonProcesses, stopFixtureDaemon } from './b4v/fixture.mjs'
import { descendants, listProcesses, readIdentity, readProcessEnv, verifyHolder, waitGone } from './b4v/process-identity.mjs'
import { daemonStateDirectory } from './session-open-bench-mode.mjs'

// Hashed into benchmarkSha256 in daemon mode only. Not in nativeHarnessFiles: the CI
// native job copies those into a baseline checkout that may predate scripts/b4v.
export const daemonSupportFiles = ['scripts/b4v/fixture.mjs', 'scripts/b4v/isolation.mjs', 'scripts/b4v/process-identity.mjs']

const fixtureFor = userData => ({ daemonState: daemonStateDirectory(userData), userDataDir: userData, ownedIdentities: [] })
const brief = ({ pid, command }) => ({ pid, command: String(command).slice(0, 200) })

/**
 * Proof the measured operations were served by a daemon of this run: the lock holder of
 * this userData's state directory is alive under its recorded identity, and its own
 * environment names this userData and state directory.
 */
export function daemonServingEvidence(userData) {
  const fixture = fixtureFor(userData)
  const holder = daemonHolder(fixture)
  if (holder.verdict !== 'verified') throw new Error(`daemon mode without a verified daemon.lock holder: ${holder.verdict}`)
  const env = readProcessEnv(holder.lock.pid, ['SCRY_DAEMON_USER_DATA_DIR', 'SCRY_DAEMON_STATE_DIR'])
  if (env.status !== 'available') throw new Error(`daemon environment unavailable: ${env.reason}`)
  if (env.env.SCRY_DAEMON_USER_DATA_DIR !== userData || env.env.SCRY_DAEMON_STATE_DIR !== fixture.daemonState) {
    throw new Error(`daemon serves another userData: ${JSON.stringify(env.env)}`)
  }
  return { holder: 'verified', pid: holder.lock.pid, startedBy: holder.lock.startedBy ?? null, userDataMatches: true }
}

/**
 * The daemon tree as it is now: supervisor and daemon by state directory, plus whatever
 * runs below them (a Provider the daemon started). The App's own cleanup must skip these
 * pids; this bench's daemon stop and leftover check cover them instead.
 */
export function daemonTree(userData) {
  const carried = fixtureDaemonProcesses(fixtureFor(userData))
  if (carried.status !== 'available') throw new Error(`daemon process scan unavailable: ${carried.reason}`)
  const roots = [...carried.supervisor, ...carried.daemon, ...carried.other]
  const rows = listProcesses()
  const tree = new Map(roots.map(row => [row.pid, row]))
  for (const root of roots) for (const row of descendants(rows, root.pid)) tree.set(row.pid, row)
  return [...tree.values()]
}

/**
 * Stop the daemon this bench caused and prove nothing of it remains: the supervisor is
 * asked first (SIGTERM aborts its daemon gracefully, so the archive is flushed), SIGKILL
 * is the bounded fallback, and `forced` says whether it was needed. Throws when any
 * process of the tree survives or the process table could not be read: an unknown
 * leftover is never reported as none.
 */
export async function stopBenchDaemon(userData, tree) {
  const fixture = fixtureFor(userData)
  const stopped = await stopFixtureDaemon(fixture)
  const descendantsLeft = await waitGone(tree.filter(row => verifyHolder(row, readIdentity(row.pid)) === 'verified'), 5_000)
  const after = fixtureDaemonProcesses(fixture)
  const holderAfter = daemonHolder(fixture).verdict
  const evidence = {
    stoppedBy: 'state-directory identity (daemon.lock + SCRY_DAEMON_STATE_DIR), each signal re-verified',
    holderBefore: stopped.holder, signals: stopped.signals,
    forced: stopped.signals.some(signal => signal.signal === 'SIGKILL' && signal.signalled),
    trackedTree: tree.length, holderAfter,
    remaining: [...stopped.remaining, ...descendantsLeft.map(brief)],
    leftoverScan: after.status === 'available'
      ? { status: 'available', live: [...after.supervisor, ...after.daemon, ...after.other].map(brief) }
      : after
  }
  if (stopped.processScan) throw new Error(`daemon stop could not scan processes: ${JSON.stringify(stopped.processScan)}`)
  if (evidence.leftoverScan.status !== 'available') throw new Error(`daemon leftover scan unavailable: ${JSON.stringify(evidence.leftoverScan)}`)
  if (evidence.remaining.length > 0 || evidence.leftoverScan.live.length > 0 || holderAfter === 'verified') {
    throw new Error(`daemon processes survived the bench: ${JSON.stringify(evidence)}`)
  }
  return evidence
}

/** Read-only failure evidence: the daemon's processes and the end of its log. */
export function daemonFailureEvidence(userData) {
  try {
    const fixture = fixtureFor(userData)
    const holder = daemonHolder(fixture)
    const carried = fixtureDaemonProcesses(fixture)
    return {
      holder: holder.verdict,
      processes: carried.status === 'available' ? [...carried.supervisor, ...carried.daemon, ...carried.other].map(brief) : carried,
      logTail: daemonLogTail(fixture, 3_000)
    }
  } catch (error) {
    return { state: 'unavailable', error: String(error) }
  }
}
