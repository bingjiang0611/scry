import { powerMonitor } from 'electron'
import type { RemoteHostService } from '../remote/remote-host-service'

// Direct LAN/overlay route for paired phones: on by default whenever the remote
// host runs, SCRY_REMOTE_LAN=0 turns it off, SCRY_REMOTE_LAN_PORT pins a port.
// It serves the same inner mTLS as the relay; nothing is reachable without a
// granted device certificate.
export function remoteLanConfig(env: NodeJS.ProcessEnv): { lan?: { port?: number } } {
  if (env.SCRY_REMOTE_LAN === '0') return {}
  const raw = env.SCRY_REMOTE_LAN_PORT
  const port = raw === undefined ? undefined : Number(raw)
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
    console.warn('[scry] ignoring invalid SCRY_REMOTE_LAN_PORT')
    return { lan: {} }
  }
  return { lan: port === undefined ? {} : { port } }
}

// After sleep every outbound relay socket is presumed dead while the relay
// still lists it as open. Replace them all on wake instead of waiting for
// heartbeat staleness. A screen unlock alone (a short lock, no sleep, same
// network) proves nothing about phone lanes in use, so it only replaces idle
// legs; a lid-open fires `resume` first, which already covered active ones.
// One listener for the process; it reads the current service on each event.
let relayPowerWatched = false
export function watchRemoteRelayPower(runtime: { remoteHostService: RemoteHostService | null }): void {
  if (relayPowerWatched) return
  relayPowerWatched = true
  powerMonitor.on('resume', () => { runtime.remoteHostService?.refreshRelay({ includeActive: true }) })
  powerMonitor.on('unlock-screen', () => { runtime.remoteHostService?.refreshRelay({ includeActive: false }) })
}
