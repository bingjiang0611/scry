import { pairingChannelHandlers } from '../../main/bootstrap/pairing-channels'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { DaemonLocalOpGroup } from './deps'

export const pairingLocalOps: DaemonLocalOpGroup = (deps) =>
  pairingChannelHandlers({ host: deps.remoteHost }) as Record<string, LocalOpHandler>
