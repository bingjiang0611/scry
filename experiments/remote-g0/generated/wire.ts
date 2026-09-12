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
