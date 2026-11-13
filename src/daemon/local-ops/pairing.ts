import { pairingChannelHandlers } from '../../main/bootstrap/pairing-channels'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { DaemonLocalOpGroup } from './deps'

// Pairing and host status, from the table main registers, over this daemon's host. The
// host exists for the App's local endpoint either way; remote access counts as enabled
// only on main's own rule (deps.remoteHost answers null otherwise), so daemon mode never
// offers pairing where the in-process App would not.
export const pairingLocalOps: DaemonLocalOpGroup = (deps) =>
  pairingChannelHandlers({ host: deps.remoteHost }) as Record<string, LocalOpHandler>
