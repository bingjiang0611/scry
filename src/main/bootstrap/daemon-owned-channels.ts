import {
  DAEMON_FORWARD_CHANNELS, DAEMON_LOCAL_OP_CHANNELS, DAEMON_MODE_IN_PROCESS_CHANNELS, DAEMON_MODE_SERVED_CHANNELS
} from '../daemon-channel-gate'
import type { TrustedRegistrar } from './agent-runtime-ipc'

/**
 * Every channel the daemon answers for this App: through a local-only op or through an op
 * it already serves paired devices (daemon-channel-gate.ts). The App registers none of
 * their implementations; the gate replaces the listener below with the forward, so only
 * the trust check and the App's own guard and result parts (installed beside the window
 * parts, e.g. project-daemon.ts) run here.
 */
export function daemonOwnedChannels(): string[] {
  return [...Object.keys(DAEMON_LOCAL_OP_CHANNELS), ...Object.keys(DAEMON_FORWARD_CHANNELS)]
    .filter((channel) => !DAEMON_MODE_IN_PROCESS_CHANNELS.has(channel) && !DAEMON_MODE_SERVED_CHANNELS.has(channel))
}

/** Registers the daemon's channels the App has not registered itself, once each. */
export function registerDaemonOwnedChannels(handleTrusted: TrustedRegistrar, registered: ReadonlySet<string>): void {
  for (const channel of daemonOwnedChannels()) {
    if (registered.has(channel)) continue
    // Never reached: gateDaemonChannel answers these from the daemon.
    handleTrusted(channel, () => { throw new Error(`daemon_capability_unavailable:${channel}`) })
  }
}
