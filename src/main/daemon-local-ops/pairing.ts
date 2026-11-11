import type { DaemonLocalOpTable } from './types'

// Pairing and host status (B4-L4): the daemon hosts paired devices while it owns runs, so
// the pairing authority is the daemon's. Local endpoint only (scope: local), like every
// local op; a pairing confirmation is the user's click in this App, sent with the key
// fingerprint the user compared, and the daemon's authority checks it fails closed.
export const PAIRING_LOCAL_OPS: DaemonLocalOpTable = {
  'remote:status': { op: 'localHostStatus', method: 'status', read: true },
  'remote:pairing:begin': { op: 'localPairing', method: 'begin', read: false },
  'remote:pairing:confirm': { op: 'localPairing', method: 'confirm', read: false },
  'remote:pairing:cancel': { op: 'localPairing', method: 'cancel', read: false },
  'remote:device:revoke': { op: 'localPairing', method: 'revoke', read: false }
}
