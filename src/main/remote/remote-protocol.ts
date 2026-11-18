import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'

// Run-channel version gate. Every request carries the version it speaks; a host
// that sees a different one refuses instead of guessing which fields are safe.
// Both sides report their own version so the caller can say which end is older.
export const HOST_PROTOCOL_VERSION = REMOTE_PROTOCOL_VERSION

export interface ProtocolMismatch {
  error: 'protocol_mismatch'
  hostProtocol: number
  // null when the request carried no usable version at all.
  clientProtocol: number | null
}

export function protocolMismatch(request: { protocol?: unknown }): ProtocolMismatch | undefined {
  const clientProtocol = typeof request.protocol === 'number' && Number.isSafeInteger(request.protocol) ? request.protocol : null
  if (clientProtocol === HOST_PROTOCOL_VERSION) return undefined
  return { error: 'protocol_mismatch', hostProtocol: HOST_PROTOCOL_VERSION, clientProtocol }
}

// Which end is behind, from the host's reported version. Unknown means the host
// did not say, and the caller must not claim either direction.
// `missing` distinguishes a host that states no version (older build) from one that
// states a different one; without a reported version no direction can be named.
export function protocolFailure(hostProtocol: unknown, missing = 'desktop_protocol_mismatch'): string {
  if (hostProtocol === undefined) return missing
  if (typeof hostProtocol !== 'number' || !Number.isSafeInteger(hostProtocol)) return 'desktop_protocol_mismatch'
  return hostProtocol < REMOTE_PROTOCOL_VERSION ? 'desktop_protocol_host_older' : 'desktop_protocol_client_older'
}

// Stamp a request with the version this build speaks. Used by the desktop client
// and by transports/tests that speak the wire directly.
export function framedRequest(request: Record<string, unknown>): Record<string, unknown> {
  return { protocol: HOST_PROTOCOL_VERSION, ...request }
}
