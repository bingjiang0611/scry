// One App channel the daemon answers through a local-only op (B4-L4): the op and method
// the matrix records (method = the channel's last segment). `read` marks calls that
// change nothing and may be asked again after a reconnect.
export interface DaemonLocalOpEntry { op: string; method: string; read: boolean }

export type DaemonLocalOpTable = Readonly<Record<string, DaemonLocalOpEntry>>

/**
 * One App channel the daemon answers through an op the remote host already serves to
 * paired devices (route `forward` in the matrix): the App builds that op's request from
 * the renderer's arguments and maps the reply back to what main's handler returns. The
 * local grant gets the full answer the op gives `scope: local`.
 */
export interface DaemonForwardEntry {
  op: string
  /** Changes nothing: may be asked again after a reconnect. */
  read: boolean
  request(args: unknown[]): Record<string, unknown>
  /** The reply as main's handler would have returned it; without it, the whole reply. */
  result?(reply: Record<string, unknown>, args: unknown[]): unknown
}

export type DaemonForwardTable = Readonly<Record<string, DaemonForwardEntry>>
