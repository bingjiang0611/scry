// Generated from wire.schema.json. Do not edit.
export interface ProbeRequest {
  protocolMajor: number
  requestId: string
  operation: "probe.echo"
  payload: string
}

export interface ProbeResponse {
  protocolMajor: number
  requestId: string
  kind: "result"
  payload: string
}

export interface PairProofRequest {
  protocolMajor: number
  requestId: string
  operation: "pair.prove"
  pairingId: string
  secret: string
  csrPEM: string
  deviceLabel: string
}

export interface PairStatusRequest {
  protocolMajor: number
  requestId: string
  operation: "pair.status"
  pairingId: string
  secret: string
}

export interface PairPendingResponse {
  protocolMajor: number
  requestId: string
  kind: "pair.pending"
  pairingId: string
  publicKeySHA256: string
}

export interface PairGrantedResponse {
  protocolMajor: number
  requestId: string
  kind: "pair.granted"
  pairingId: string
  deviceId: string
  certificatePEM: string
  certificateSHA256: string
  expiresAt: number
  scope: "g0_echo_only"
}

export interface PairRevokedResponse {
  protocolMajor: number
  requestId: string
  kind: "pair.revoked"
  pairingId: string
  deviceId: string
}

export interface PairDeniedResponse {
  protocolMajor: number
  requestId: string
  kind: "pair.denied"
  code: string
}
