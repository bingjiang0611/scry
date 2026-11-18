import type { DaemonLocalOpTable } from './types'

// The «后台服务» section (B4-S S0-1), a split channel: the App composes what it knows
// itself (its connection outcome, the verified daemon.lock holder) with what only the
// daemon knows, asked here. Local endpoint only (scope: local); the op name is not a
// device op. The three actions stay in main (dialogs, signals, app.quit).
export const BACKGROUND_SERVICE_LOCAL_OPS: DaemonLocalOpTable = {
  'remote:backgroundService:status': { op: 'localBackgroundService', method: 'status', read: true }
}
