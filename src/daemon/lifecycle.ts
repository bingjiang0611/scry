import { acquireDaemonLock, type DaemonLockRecord } from './ledger-lock'

// Startup for the daemon: read the state directory the App handed over, take the
// single-writer lock, and stop with a readable reason when another daemon owns it.
// Host wiring (createHostRuntime + createRunPipeline) is the next step; until it
// lands this module deliberately does not pretend the daemon is serving.
export interface DaemonStartupInput {
  /** Absolute directory owned by the daemon; `<userData>/daemon` in the App layout. */
  stateDirectory: string
  startedBy: string
  /** This daemon's own entry, so a reused pid that looks like it is not taken over. */
  daemonEntry?: string
  log?: (line: string) => void
}

export type DaemonStartupResult =
  | { status: 'started'; lock: DaemonLockRecord; release: () => void }
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
  log(`daemon.started pid=${outcome.record.pid} stateDirectory=${input.stateDirectory}`)
  return { status: 'started', lock: outcome.record, release: outcome.release }
}
