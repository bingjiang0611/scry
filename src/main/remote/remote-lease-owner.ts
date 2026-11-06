import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { parseProcessSnapshot, processIdentityKey, type ProcessRow } from '../process-diagnostics'

export interface RemoteLeaseOwner {
  pid: number
  lease: string
  createdAt: number
  /** `ps lstart` captured with LC_ALL=C and TZ=UTC. */
  startedAt: string
  identityKey: string
}

export function utcRemoteProcessSnapshot(): ReadonlyMap<number, ProcessRow> {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart=,command='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
  })
  return parseProcessSnapshot(output)
}

export function createRemoteLeaseOwner(
  pid = process.pid,
  lister: () => ReadonlyMap<number, ProcessRow> = utcRemoteProcessSnapshot
): RemoteLeaseOwner {
  const row = lister().get(pid)
  if (!row?.startedAt) throw new Error('remote_lease_identity_unavailable')
  return {
    pid,
    lease: randomUUID(),
    createdAt: Date.now(),
    startedAt: row.startedAt,
    identityKey: processIdentityKey(row)
  }
}
