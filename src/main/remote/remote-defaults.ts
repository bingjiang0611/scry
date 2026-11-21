import { daemonModeEnabled } from '../daemon-channel-gate'
import { remoteHostEnabled } from '../../shared/remote-host-policy'

export { remoteHostEnabled }

// Official public relay used by packaged Scry builds. It is only an untrusted
// byte rendezvous: the phone still pins the per-install inner CA and all remote
// application traffic remains inside TLS 1.3 mTLS.
export const DEFAULT_PUBLIC_RELAY_WS = 'wss://scry-relay-pages.pages.dev'

// Whether this App process hosts paired devices itself. While the daemon owns runs it
// serves them from the same userData, so the App must not open a second host there.
export function inProcessRemoteHostEnabled(env: NodeJS.ProcessEnv, isPackaged: boolean): boolean {
  return !daemonModeEnabled(env) && remoteHostEnabled(env.SCRY_REMOTE_HOST, isPackaged)
}
