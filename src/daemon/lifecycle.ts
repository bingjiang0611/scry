import { acquireDaemonLock, type DaemonLockRecord } from './ledger-lock'
import { acquireUserDataLock, USERDATA_OWNED_ERROR } from './userdata-lock'

// Startup for the daemon: read the state directory the App handed over, take the
// single-writer locks (state directory, then userData), and stop with a readable reason
// when another daemon owns either.
// Host wiring (createHostRuntime + createRunPipeline) is the next step; until it
// lands this module deliberately does not pretend the daemon is serving.
export interface DaemonStartupInput {
  /** Absolute directory owned by the daemon; `<userData>/daemon` in the App layout. */
  stateDirectory: string
  /**
   * The userData this daemon will write. Required: a daemon that skipped the userData lock
   * could share scry.db with a daemon started from another state directory.
   */
  userDataDir: string
  startedBy: string
  /** This daemon's own entry, so a reused pid that looks like it is not taken over. */
  daemonEntry?: string
  /** Construct the serving host only after this process owns the ledger lock. */
  startHost?: () => Promise<{ dispose(): Promise<void> }>
  log?: (line: string) => void
}

export type DaemonStartupResult =
  | { status: 'started'; lock: DaemonLockRecord; release: () => void; dispose: () => Promise<void> }
  | { status: 'already-running'; holder: DaemonLockRecord; reason?: string }

const EXIT_ALREADY_RUNNING = 3

export function exitCodeForStartup(result: DaemonStartupResult): number {
  // A daemon that already owns the ledger is not an error in itself, but this
  // process must not start: report it with a distinct code and leave the file alone.
  if (result.status === 'already-running') return EXIT_ALREADY_RUNNING
  return 0
}

export async function startDaemon(input: DaemonStartupInput): Promise<DaemonStartupResult> {
  const log = input.log ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  const outcome = await acquireDaemonLock({
    directory: input.stateDirectory,
    startedBy: input.startedBy,
    daemonEntry: input.daemonEntry
  })
  if (outcome.status === 'already-running') {
    // The holder owns the ledger. Say who it is and leave without touching a file.
    log(`daemon.already-running pid=${outcome.holder.pid} reason=${outcome.reason ?? 'live-holder'} stateDirectory=${input.stateDirectory}`)
    return { status: 'already-running', holder: outcome.holder, reason: outcome.reason }
  }
  if (outcome.status === 'replaced-stale' && outcome.previous) {
    // Taking over is a file operation: the process that reused the pid is not ours to
    // stop, so it is only named here, never signalled.
    log(`daemon.took-over reason=${outcome.reason} stalePid=${outcome.previous.pid}`)
  }
  // Second lock, taken only by the daemon that owns its state directory: a daemon that
  // lost the first race leaves above without touching the userData record.
  let userData: Awaited<ReturnType<typeof acquireUserDataLock>>
  try {
    userData = await acquireUserDataLock({
      userDataDir: input.userDataDir,
      role: 'daemon',
      startedBy: input.startedBy,
      ...(input.daemonEntry ? { daemonEntry: input.daemonEntry } : {})
    })
  } catch (error) {
    outcome.release()
    throw error
  }
  if (userData.status === 'owned') {
    // Another live writer owns this userData. Give back the state-directory lock so a
    // later daemon there is not blocked by this one, name the holder, and stop: the
    // machine code makes the supervisor stop instead of restarting into the same answer.
    outcome.release()
    log(`daemon.userdata-owned holderPid=${userData.holder.pid} holderRole=${userData.holder.role ?? 'unknown'} reason=${userData.reason}`)
    throw new Error(USERDATA_OWNED_ERROR)
  }
  const userDataLock = userData
  if (userDataLock.previous) log(`daemon.userdata-took-over stalePid=${userDataLock.previous.pid}`)
  // userData first, then the state directory: the reverse of acquisition.
  const releaseAll = (): void => {
    try { userDataLock.release() } finally { outcome.release() }
  }
  try {
    const host = await input.startHost?.()
    log(`daemon.started pid=${outcome.record.pid} stateDirectory=${input.stateDirectory}`)
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      try { await host?.dispose() } finally { releaseAll() }
    }
    return { status: 'started', lock: outcome.record, release: releaseAll, dispose }
  } catch (error) {
    releaseAll()
    throw error
  }
}
