
export interface RemotePairingCode {
  pairingId: string
  secret: string
  hostId: string
  anchorSHA256: string
  expiresAt: number
  deviceCode: string | null
}

export interface RemotePendingPairing {
  pairingId: string
  state: 'created' | 'awaiting_local_confirmation'
  expiresAt: number
  deviceLabel?: string
  publicKeySHA256?: string
}

export interface RemoteDevice {
  deviceId: string
  deviceLabel: string
  expiresAt: number
  confirmedAt: number
  revoked: boolean
  approvedVia?: 'app' | 'host_cli'
}

export interface RemoteRelayDiagnostics {
  waiting: number
  active: number
  opening: number
  limit: number
}

export type RemoteStatus =
  | { enabled: false }
  | {
      enabled: true
      hostId: string
      anchorSHA256: string
      relayConfigured: boolean
      relay?: RemoteRelayDiagnostics
      pending: RemotePendingPairing[]
      devices: RemoteDevice[]
    }
