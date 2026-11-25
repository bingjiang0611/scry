import type { DaemonForwardTable, DaemonLocalOpTable } from './types'

// Session delete, rename/archive/pin, fork, archived list and purge; then conversation delete/fork.
// The App's own session semantics (empty-cwd sessions, deleting an unarchived session
// after the App's dialog), which the device ops sessionAction/sessionDelete do not have.
// Writes are never replayed after a lost reply.
export const SESSION_LIFECYCLE_LOCAL_OPS: DaemonLocalOpTable = {
  'agent:renameSession': { op: 'sessionLifecycle', method: 'renameSession', read: false },
  'agent:setSessionPinned': { op: 'sessionLifecycle', method: 'setSessionPinned', read: false },
  'agent:setSessionArchived': { op: 'sessionLifecycle', method: 'setSessionArchived', read: false },
  'agent:deleteSession': { op: 'sessionLifecycle', method: 'deleteSession', read: false },
  // Starts the Provider's native fork; the App fills a missing cwd with the window's.
  'agent:forkSession': { op: 'sessionLifecycle', method: 'forkSession', read: false },
  'agent:listArchivedSessions': { op: 'sessionStore', method: 'listArchivedSessions', read: true },
  // The App asks first and sends the count it asked about (session-lifecycle-daemon.ts).
  'agent:deleteArchivedSessions': { op: 'sessionPurge', method: 'deleteArchivedSessions', read: false }
}

export const SESSION_LIFECYCLE_FORWARDS: DaemonForwardTable = {}

// Host authority over the run the App is looking at (D1 queue, D5 rollback, C4 restart continue).
// The daemon answers these and main forwards them; without an entry here the daemon replied
// `unsupported_op` to a channel main had already forwarded.
export const HOST_AUTHORITY_LOCAL_OPS: DaemonLocalOpTable = {
  'agent:hostQueue': { op: 'hostQueue', method: 'hostQueue', read: true },
  'agent:releaseQueuedRun': { op: 'checkpoints', method: 'releaseQueuedRun', read: false },
  'agent:rollbackRun': { op: 'checkpoints', method: 'rollbackRun', read: false },
  'agent:restartNote': { op: 'restartNote', method: 'restartNote', read: true },
  'agent:continueAfterRestart': { op: 'restartNote', method: 'continueAfterRestart', read: false }
}
