import { pairingChannelHandlers } from '../../main/bootstrap/pairing-channels'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { BackgroundServiceSelfReport } from '../../shared/background-service'
import type { DaemonLocalOpGroup } from './deps'

// What only the daemon knows for the «后台服务» section (B4-S S0-1): its own version,
// pid, start time, paired devices and unsettled runs. Local endpoint only, like every
// local op. Devices are counted from the same remote:status main answers, which already
// leaves out the App's own local grant; remote access off is reported as such.
export const backgroundServiceLocalOps: DaemonLocalOpGroup = (deps) => {
  const remoteStatus = pairingChannelHandlers({ host: deps.remoteHost })['remote:status']
  return {
    'remote:backgroundService:status': (...args: unknown[]): BackgroundServiceSelfReport => {
      if (args.length > 0) throw new Error('invalid_request')
      const remote = remoteStatus()
      const now = Date.now()
      return {
        version: deps.appVersion,
        pid: process.pid,
        startedAt: Math.round(performance.timeOrigin),
        devices: remote.enabled
          ? { state: 'known', paired: remote.devices.filter((device) => !device.revoked && device.expiresAt > now).length }
          : { state: 'remote-disabled' },
        activeRuns: deps.runs().unsettledStates().length
      }
    }
  } as Record<string, LocalOpHandler>
}
