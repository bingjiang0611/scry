import { powerMonitor } from 'electron'
import type { RemoteHostService } from '../remote/remote-host-service'

// The LAN route's configuration is Electron-free so the daemon reads it the same way.
export { remoteLanConfig } from '../remote/remote-lan-config'

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
