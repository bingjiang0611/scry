import type { RemoteDevice, RemotePendingPairing, RemoteRelayDiagnostics, RemoteStatus } from '../../shared/remote'
import type { DeviceGrant, PairingState } from './pairing'
import type { RelayDiagnostics } from './relay-client'

// Pure display-safe projection helpers for RemoteHostService: keeps pairing secrets,
// private keys, and certificate PEMs out of status DTOs.

export function encodePairingDeviceCode(input: {
  relay: { host: string; port: number; tls: 'system' | 'plaintext' } | null
  relayConfigured: boolean
  hostId: string
  caCertificatePEM: string
  code: { pairingId: string; secret: string }
}): string | null {
  if (!input.relay || !input.relayConfigured) return null
  const payload = {
    relayHost: input.relay.host,
    relayPort: input.relay.port,
    relayTLS: input.relay.tls,
    hostId: input.hostId,
    pairingId: input.code.pairingId,
    secret: input.code.secret,
    anchorPEM: input.caCertificatePEM
  }
  return `scry1:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

export function projectRemoteDevice(grant: DeviceGrant): RemoteDevice {
  return {
    deviceId: grant.deviceId,
    deviceLabel: grant.deviceLabel,
    expiresAt: grant.expiresAt,
    confirmedAt: grant.confirmedAt,
    revoked: grant.revokedAt !== null,
    ...(grant.approvedVia ? { approvedVia: grant.approvedVia } : {})
  }
}

export function projectRemoteStatus(input: {
  state: PairingState
  hostId: string
  anchorSHA256: string
  relayConfigured: boolean
  relayDiagnostics: Array<RelayDiagnostics | undefined>
}): RemoteStatus {
  const pending: RemotePendingPairing[] = input.state.pairings
    .filter((p): p is typeof p & { state: 'created' | 'awaiting_local_confirmation' } => p.state === 'created' || p.state === 'awaiting_local_confirmation')
    .map((p) => p.state === 'awaiting_local_confirmation'
      ? { pairingId: p.pairingId, state: p.state, expiresAt: p.expiresAt, deviceLabel: p.proof.deviceLabel, publicKeySHA256: p.proof.publicKeySHA256 }
      : { pairingId: p.pairingId, state: p.state, expiresAt: p.expiresAt })
  const devices = input.state.grants.map(projectRemoteDevice)
  const relayStates = input.relayDiagnostics.filter((value): value is RelayDiagnostics => value !== undefined)
  const relay: RemoteRelayDiagnostics | undefined = relayStates.length === 0 ? undefined : relayStates.reduce((total, value) => ({
    waiting: total.waiting + value.waiting,
    active: total.active + value.active,
    opening: total.opening + value.opening,
    limit: total.limit + value.limit
  }), { waiting: 0, active: 0, opening: 0, limit: 0 })
  return {
    enabled: true,
    hostId: input.hostId,
    anchorSHA256: input.anchorSHA256,
    relayConfigured: input.relayConfigured,
    ...(relay ? { relay } : {}),
    pending,
    devices
  }
}
