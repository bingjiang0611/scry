import { acquireDaemonLock, type DaemonLockRecord } from './ledger-lock'

// Startup for the daemon: read the state directory the App handed over, take the
// single-writer lock, and stop with a readable reason when another daemon owns it.
// Host wiring (createHostRuntime + createRunPipeline) is the next step; until it
// lands this module deliberately does not pretend the daemon is serving.
export interface DaemonStartupInput {
  /** Absolute directory owned by the daemon; `<userData>/daemon` in the App layout. */
  stateDirectory: string
  startedBy: string
  log?: (line: string) => void
}

export type DaemonStartupResult =
  | { status: 'started'; lock: DaemonLockRecord; release: () => void }
  | { status: 'already-running'; holder: DaemonLockRecord }
  | { status: 'identity-changed'; holder: DaemonLockRecord }

const EXIT_ALREADY_RUNNING = 3
const EXIT_IDENTITY_CHANGED = 4

export function exitCodeForStartup(result: DaemonStartupResult): number {
  if (result.status === 'already-running') return EXIT_ALREADY_RUNNING
  if (result.status === 'identity-changed') return EXIT_IDENTITY_CHANGED
  return 0
}

export function startDaemon(input: DaemonStartupInput): DaemonStartupResult {
  const log = input.log ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  const outcome = acquireDaemonLock({ directory: input.stateDirectory, startedBy: input.startedBy })
  if (outcome.status === 'already-running') {
    // The holder owns the ledger. Say who it is and leave without touching a file.
    log(`daemon.already-running pid=${outcome.holder.pid} stateDirectory=${input.stateDirectory}`)
    return { status: 'already-running', holder: outcome.holder }
  }
  if (outcome.status === 'identity-changed') {
    log(`daemon.identity-changed recordedPid=${outcome.holder.pid} stateDirectory=${input.stateDirectory}`)
    return { status: 'identity-changed', holder: outcome.holder }
  }
  if (outcome.status === 'replaced-stale' && outcome.previous) {
    log(`daemon.took-over stalePid=${outcome.previous.pid}`)
  }
  log(`daemon.started pid=${outcome.record.pid} stateDirectory=${input.stateDirectory}`)
  return { status: 'started', lock: outcome.record, release: outcome.release }
}
