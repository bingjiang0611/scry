import { acquireDaemonLock, type DaemonLockRecord } from './ledger-lock'
import { acquireUserDataLock, USERDATA_OWNED_ERROR } from './userdata-lock'

export interface DaemonStartupInput {
  stateDirectory: string
  userDataDir: string
  startedBy: string
  daemonEntry?: string
  startHost?: () => Promise<{ dispose(): Promise<void> }>
  log?: (line: string) => void
}

export type DaemonStartupResult =
  | { status: 'started'; lock: DaemonLockRecord; release: () => void; dispose: () => Promise<void> }
  | { status: 'already-running'; holder: DaemonLockRecord; reason?: string }

const EXIT_ALREADY_RUNNING = 3

export function exitCodeForStartup(result: DaemonStartupResult): number {
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
    log(`daemon.already-running pid=${outcome.holder.pid} reason=${outcome.reason ?? 'live-holder'} stateDirectory=${input.stateDirectory}`)
    return { status: 'already-running', holder: outcome.holder, reason: outcome.reason }
  }
  if (outcome.status === 'replaced-stale' && outcome.previous) {
    log(`daemon.took-over reason=${outcome.reason} stalePid=${outcome.previous.pid}`)
  }
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
    outcome.release()
    log(`daemon.userdata-owned holderPid=${userData.holder.pid} holderRole=${userData.holder.role ?? 'unknown'} reason=${userData.reason}`)
    throw new Error(USERDATA_OWNED_ERROR)
  }
  const userDataLock = userData
  if (userDataLock.previous) log(`daemon.userdata-took-over stalePid=${userDataLock.previous.pid}`)
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
