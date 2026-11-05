import { startDaemon, exitCodeForStartup } from './lifecycle'

// Daemon entry. It runs on the App's Electron binary with ELECTRON_RUN_AS_NODE=1,
// so it gets the same Node, the same ABI for better-sqlite3 and the same signature;
// the trade-off is that no Electron API may be reached from here (enforced by
// src/daemon/daemon-imports.test.ts, not by convention).
//
// The App passes its own userData directory; a daemon that guesses one would write
// to the wrong ledger, so a missing value fails loudly instead of defaulting.
const stateDirectory = process.env.SCRY_DAEMON_STATE_DIR
if (!stateDirectory) {
  process.stderr.write('daemon_state_dir_missing: set SCRY_DAEMON_STATE_DIR\n')
  process.exit(2)
}

const startedBy = process.env.SCRY_DAEMON_STARTED_BY ?? 'unknown'
const result = await startDaemon({
  stateDirectory, startedBy,
  // A pid that reused ours and still runs this entry cannot be told apart from a
  // live daemon, so the lock refuses to start a second writer instead of guessing.
  daemonEntry: 'daemon.js'
})
if (result.status !== 'started') process.exit(exitCodeForStartup(result))
// The host is not wired yet (P1-2), so this process has no work to keep it alive and
// must not look like a healthy daemon to whatever started it. Exiting with its own
// code leaves no stale lock and no supervisor that believes the daemon is serving.
process.stderr.write('daemon_host_not_wired: this build acquires the lock and exits\n')
result.release()
process.exit(5)
