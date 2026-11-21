import { installDaemonChannelResultHandler } from '../daemon-channel-gate'

/**
 * agent:newSession: the daemon resets the context it runs (resetProviderSession in
 * startup-channels.ts); once it answered, this window views no session.
 */
export function viewNothingAfterDaemonNewSession(dockBadge: { view: (key: string | null, focused: boolean) => void }, isFocused: () => boolean): () => void {
  return installDaemonChannelResultHandler('agent:newSession', (value) => {
    dockBadge.view(null, isFocused())
    return value
  })
}
