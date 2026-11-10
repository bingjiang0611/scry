import { daemonModeEnabled } from '../daemon-channel-gate'

// Startup steps of main that write userData the daemon owns once the switch is on
// (P3-userdata-lock.md, case 2). The daemon's host process runs the same two steps
// under its userData lock (host-process: initDb, runStartupRecovery); main running them
// as well would be a second writer of scry.db, the outbox, the session ledger and the
// recorder journals, and its temp-file cleanup could delete a file the daemon is still
// renaming into place. With the switch off nothing changes: main owns userData.
export interface AppStartupWriters {
  /** Open scry.db and run its migrations. */
  database: boolean
  /** Outbox replay, temp cleanup, ledger and managed-turn recovery, commit hook redelivery. */
  startupRecovery: boolean
}

export function appStartupWriters(env: NodeJS.ProcessEnv = process.env): AppStartupWriters {
  const appOwnsUserData = !daemonModeEnabled(env)
  return { database: appOwnsUserData, startupRecovery: appOwnsUserData }
}
