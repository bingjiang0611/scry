import { remoteHostEnabled } from '../../shared/remote-host-policy'

export { remoteHostEnabled }

// Official public relay used by packaged Scry builds. It is only an untrusted
// byte rendezvous: the phone still pins the per-install inner CA and all remote
// application traffic remains inside TLS 1.3 mTLS.
export const DEFAULT_PUBLIC_RELAY_WS = 'wss://scry-relay-pages.pages.dev'
