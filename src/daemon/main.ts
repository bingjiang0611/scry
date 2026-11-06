import { resolve } from 'node:path'
import { startDaemon, exitCodeForStartup } from './lifecycle'
import { createDaemonHostProcess } from './host-process'

// Daemon entry. It runs on the App's Electron binary with ELECTRON_RUN_AS_NODE=1,
// so it gets the same Node, the same ABI for better-sqlite3 and the same signature;
// the trade-off is that no Electron API may be reached from here (enforced by
// src/daemon/daemon-imports.test.ts, not by convention).
//
// The App passes its own userData directory; a daemon that guesses one would write
// to the wrong ledger, so a missing value fails loudly instead of defaulting.
const stateDirectory = process.env.SCRY_DAEMON_STATE_DIR
const userDataDir = process.env.SCRY_DAEMON_USER_DATA_DIR
if (!stateDirectory || !userDataDir) {
  process.stderr.write('daemon_paths_missing: set SCRY_DAEMON_STATE_DIR and SCRY_DAEMON_USER_DATA_DIR\n')
  process.exit(2)
}

const startedBy = process.env.SCRY_DAEMON_STARTED_BY ?? 'unknown'
// The absolute path of this entry, not a basename: the lock compares it against the
// command line of a reused pid, and a short marker would match unrelated processes
// (or miss this one when it is installed somewhere else).
const daemonEntry = resolve(process.argv[1] ?? '')
const appPath = resolve(process.env.SCRY_DAEMON_APP_PATH ?? process.cwd())
const resourcesPath = resolve(process.env.SCRY_DAEMON_RESOURCES_PATH ?? `${appPath}/resources`)
const result = await startDaemon({
  stateDirectory,
  startedBy,
  daemonEntry,
  startHost: () => createDaemonHostProcess({
    userDataDir,
    daemonStateDirectory: stateDirectory,
    appPath,
    resourcesPath,
    appVersion: process.env.SCRY_DAEMON_APP_VERSION ?? '0.2.237',
    isPackaged: process.env.SCRY_DAEMON_PACKAGED === '1'
  })
})
if (result.status !== 'started') process.exit(exitCodeForStartup(result))

let stopping = false
const stop = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  try { await result.dispose() } finally { process.exit(0) }
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
