import { daemonModeEnabled } from '../daemon-channel-gate'

// Official public relay used by packaged Scry builds. It is only an untrusted
// byte rendezvous: the phone still pins the per-install inner CA and all remote
// application traffic remains inside TLS 1.3 mTLS.
export const DEFAULT_PUBLIC_RELAY_WS = 'wss://scry-relay-pages.pages.dev'

// Packaged builds enable remote reachability by default. Development remains
// opt-in to avoid silently using production infrastructure, and either build
// can be explicitly overridden for diagnostics or managed deployments.
export function remoteHostEnabled(value: string | undefined, isPackaged: boolean): boolean {
  if (value === '1') return true
  if (value === '0') return false
  return value === undefined && isPackaged
}

// Whether this App process hosts paired devices itself. While the daemon owns runs it
// serves them from the same userData, so the App must not open a second host there.
export function inProcessRemoteHostEnabled(env: NodeJS.ProcessEnv, isPackaged: boolean): boolean {
  return !daemonModeEnabled(env) && remoteHostEnabled(env.SCRY_REMOTE_HOST, isPackaged)
}
