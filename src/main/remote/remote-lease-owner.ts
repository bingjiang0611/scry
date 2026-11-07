import { randomUUID } from 'node:crypto'
import {
  currentProcessIdentitySync,
  processIdentityKey,
  readProcessIdentitySync,
  type ProcessRow
} from '../process-diagnostics'

export interface RemoteLeaseOwner {
  pid: number
  lease: string
  createdAt: number
  /** Stable display/evidence value; identityKey is authoritative. */
  startedAt: string
  identityKey: string
}

/** Compatibility/test helper; production recovery reads only the requested pid. */
export function utcRemoteProcessSnapshot(pid = process.pid): ReadonlyMap<number, ProcessRow> {
  const row = readProcessIdentitySync(pid)
  return row ? new Map([[pid, row]]) : new Map()
}

export function createRemoteLeaseOwner(
  pid = process.pid,
  lister?: () => ReadonlyMap<number, ProcessRow>
): RemoteLeaseOwner {
  // Pairing, ledger and output stores are constructed together. Cache this process'
  // exact identity instead of synchronously querying the OS once per store.
  const row = lister ? lister().get(pid) : pid === process.pid ? currentProcessIdentitySync() : readProcessIdentitySync(pid)
  if (!row?.startedAt) throw new Error('remote_lease_identity_unavailable')
  return {
    pid,
    lease: randomUUID(),
    createdAt: Date.now(),
    startedAt: row.startedAt,
    identityKey: processIdentityKey(row)
  }
}
