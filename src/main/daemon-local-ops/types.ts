// One App channel the daemon answers through a local-only op (B4-L4): the op and method
// the matrix records (method = the channel's last segment). `read` marks calls that
// change nothing and may be asked again after a reconnect.
export interface DaemonLocalOpEntry { op: string; method: string; read: boolean }

export type DaemonLocalOpTable = Readonly<Record<string, DaemonLocalOpEntry>>
