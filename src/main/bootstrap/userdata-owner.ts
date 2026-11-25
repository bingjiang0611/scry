import type { DaemonLockRecord } from '../../daemon/ledger-lock'
import { processIdentityKey, type ProcessRow } from '../process-diagnostics'

// In daemon mode the daemon owns userData. After the user confirms a stop,
// background-service-stop.ts rechecks the holder of `scry-userdata.lock` and
// its process identity before signaling.

export type SignalCheckFailure =
  | 'lock-released'
  /** The process is gone or a zombie; its record is stale and the takeover rules apply. */
  | 'holder-exited'
  /** The lock now describes another holder than the one the user agreed to stop. */
  | 'lock-changed'
  /** The pid now belongs to a process with another start identity (pid reuse). */
  | 'identity-changed'
  /** The pid's identity could not be read, so it cannot be proven to be the daemon. */
  | 'identity-unreadable'
  | 'identity-unrecorded'

export type SignalCheck = { ok: true } | { ok: false; reason: SignalCheckFailure }

/**
 * Last check before SIGTERM: the record still names the holder the user saw, and the pid
 * still has the identity that record captured. Same evidence as daemon.lock, but stricter:
 * only an exact identity key match permits a signal.
 */
export function checkDaemonBeforeSignal(
  asked: DaemonLockRecord,
  current: DaemonLockRecord | undefined,
  row: ProcessRow | undefined | 'unreadable'
): SignalCheck {
  if (!asked.identityKey) return { ok: false, reason: 'identity-unrecorded' }
  if (!current) return { ok: false, reason: 'lock-released' }
  if (!sameHolder(asked, current) || current.role !== asked.role) return { ok: false, reason: 'lock-changed' }
  if (row === 'unreadable') return { ok: false, reason: 'identity-unreadable' }
  if (!row || row.status.startsWith('Z')) return { ok: false, reason: 'holder-exited' }
  if (processIdentityKey(row) !== asked.identityKey) return { ok: false, reason: 'identity-changed' }
  return { ok: true }
}

function sameHolder(a: DaemonLockRecord, b: DaemonLockRecord): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt && a.identityKey === b.identityKey
}
