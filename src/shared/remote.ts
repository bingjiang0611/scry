// DTOs for the trusted-LOCAL remote-access pairing UI. These cross the
// main<->renderer boundary, so they carry only what the Mac's own pairing screen
// needs to display and act on. They deliberately never include the pairing
// secret verifier, private keys, or issued certificate PEMs.

// One-time pairing code the Mac shows (as text/QR) for a device to consume. The
// secret is short-lived (single-use, ~2 min TTL) and is the whole point of the
// code, so it is surfaced here for display; anchorSHA256 lets the device pin the
// host's inner CA.
export interface RemotePairingCode {
  pairingId: string
  secret: string
  hostId: string
  anchorSHA256: string
  expiresAt: number
}

// A pairing in progress. 'awaiting_local_confirmation' means a device proved
// possession over the verified transport and is waiting for the operator to
// confirm the displayed key fingerprint on the Mac.
export interface RemotePendingPairing {
  pairingId: string
  state: 'created' | 'awaiting_local_confirmation'
  expiresAt: number
  deviceLabel?: string
  publicKeySHA256?: string
}

// A granted (paired) device. `revoked` reflects a durable revocation; a revoked
// grant is shown, never silently dropped.
export interface RemoteDevice {
  deviceId: string
  deviceLabel: string
  expiresAt: number
  confirmedAt: number
  revoked: boolean
}

// Full snapshot for the pairing screen. `enabled=false` is a real, honest state
// (the subsystem is not running because SCRY_REMOTE_HOST is unset) and must not
// be rendered as an empty-but-ready host.
export type RemoteStatus =
  | { enabled: false }
  | {
      enabled: true
      hostId: string
      anchorSHA256: string
      // Whether an outbound relay leg is configured. When false the host can
      // pair locally but no device can reach it yet (dormant).
      relayConfigured: boolean
      pending: RemotePendingPairing[]
      devices: RemoteDevice[]
    }
