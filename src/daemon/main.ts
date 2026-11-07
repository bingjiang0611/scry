import { resolve } from 'node:path'
import { startDaemon, exitCodeForStartup } from './lifecycle'
import { createDaemonHostProcess } from './host-process'
import { readDaemonProcessConfig } from './daemon-config'
import { createDaemonSignalShutdown } from './signal-shutdown'
import { classifyDaemonStartupFailure } from './startup-failure'

// Daemon entry. It runs on the App's Electron binary with ELECTRON_RUN_AS_NODE=1,
// so it gets the same Node, the same ABI for better-sqlite3 and the same signature;
// the trade-off is that no Electron API may be reached from here (enforced by
// src/daemon/daemon-imports.test.ts, not by convention).
//
// The App passes its own userData directory; a daemon that guesses one would write
// to the wrong ledger, so a missing value fails loudly instead of defaulting.
let config: ReturnType<typeof readDaemonProcessConfig>
try { config = readDaemonProcessConfig(process.env) } catch (error) {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exit(2)
}
const { stateDirectory, userDataDir, appPath, resourcesPath, appVersion, isPackaged } = config

const shutdown = createDaemonSignalShutdown()
process.on('SIGTERM', () => { shutdown.stop() })
process.on('SIGINT', () => { shutdown.stop() })

const startedBy = process.env.SCRY_DAEMON_STARTED_BY ?? 'unknown'
// The absolute path of this entry, not a basename: the lock compares it against the
// command line of a reused pid, and a short marker would match unrelated processes
// (or miss this one when it is installed somewhere else).
const daemonEntry = resolve(process.argv[1] ?? '')
const result = await startDaemon({
  stateDirectory,
  startedBy,
  daemonEntry,
  startHost: () => createDaemonHostProcess({
    userDataDir,
    daemonStateDirectory: stateDirectory,
    appPath,
    resourcesPath,
    appVersion,
    isPackaged
  })
}).catch((error: unknown) => {
  // A blocked host (live lease holder, unverifiable owner, missing private CLI) cannot
  // be fixed by waiting, so it gets its own exit code and the supervisor stops. Only the
  // machine code is written: stderr may otherwise carry paths or provider detail.
  const failure = classifyDaemonStartupFailure(error)
  process.stderr.write(`${failure.reason ?? (error instanceof Error ? error.message : 'daemon_startup_failed')}\n`)
  process.exit(failure.code)
})
if (result.status !== 'started') process.exit(exitCodeForStartup(result))
shutdown.ready(result.dispose)
