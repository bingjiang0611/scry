import type { RemoteStatus, RemotePendingPairing, RemoteDevice } from '../shared/remote'

// Pure projection for the trusted-LOCAL remote-access pairing screen. It maps
// the honest RemoteStatus envelope into a view model the component renders, and
// enforces the confirm-time safety check, with NO React or IPC. Kept in a .ts so
// the honesty semantics are unit-tested without the heavy Electron UI harness.
//
// Honesty rules encoded here (mirrors CLAUDE.md / src/shared/remote.ts):
//  - enabled:false is a real state ("远程访问未启用"), never an empty-but-ready host.
//  - relayConfigured:false is surfaced truthfully: the host pairs locally but no
//    device can reach it yet (dormant) — not shown as connected/ready.
//  - A pending device is only actionable once it reached awaiting_local_confirmation
//    AND exposes the key fingerprint the operator must compare.
//  - A revoked grant is shown as revoked, never dropped or shown as active.
//  - Confirming requires the operator-seen fingerprint to equal the pending
//    device's proven publicKeySHA256 (fail closed on mismatch/absence), matching
//    the main-process confirmPairing binding.

export type RemotePairingViewModel =
  | { kind: 'disabled' }
  | {
      kind: 'enabled'
      hostId: string
      anchorSHA256: string
      relayReady: boolean
      relayHint: string
      pending: PendingRow[]
      devices: DeviceRow[]
      hasActionablePending: boolean
    }

export interface PendingRow {
  pairingId: string
  label: string
  // Present + confirmable only in awaiting_local_confirmation with a fingerprint.
  fingerprint: string | null
  fingerprintShort: string | null
  confirmable: boolean
  statusText: string
  expiresAt: number
}

export interface DeviceRow {
  deviceId: string
  label: string
  revoked: boolean
  statusText: string
  confirmedAt: number
  expiresAt: number
}

const HASH = /^[0-9a-f]{64}$/

export function shortFingerprint(hash: string): string {
  // Group the first bytes for eyeball comparison against the phone; never claim
  // more than we have (returns the raw value if it is not a full digest).
  if (!HASH.test(hash)) return hash
  return hash.slice(0, 16).replace(/(.{4})/g, '$1 ').trim().toUpperCase()
}

function projectPending(p: RemotePendingPairing): PendingRow {
  const confirmable = p.state === 'awaiting_local_confirmation' && typeof p.publicKeySHA256 === 'string' && HASH.test(p.publicKeySHA256)
  const fingerprint = confirmable ? (p.publicKeySHA256 as string) : null
  return {
    pairingId: p.pairingId,
    label: p.deviceLabel && p.deviceLabel.trim().length > 0 ? p.deviceLabel : '未命名设备',
    fingerprint,
    fingerprintShort: fingerprint ? shortFingerprint(fingerprint) : null,
    confirmable,
    statusText: confirmable ? '等待你在 Mac 上确认指纹' : '设备连接中…',
    expiresAt: p.expiresAt
  }
}

function projectDevice(d: RemoteDevice): DeviceRow {
  return {
    deviceId: d.deviceId,
    label: d.deviceLabel && d.deviceLabel.trim().length > 0 ? d.deviceLabel : '未命名设备',
    revoked: d.revoked,
    statusText: d.revoked ? '已吊销' : '已配对',
    confirmedAt: d.confirmedAt,
    expiresAt: d.expiresAt
  }
}

export function projectRemote(status: RemoteStatus): RemotePairingViewModel {
  if (!status.enabled) return { kind: 'disabled' }
  const pending = status.pending.map(projectPending)
  return {
    kind: 'enabled',
    hostId: status.hostId,
    anchorSHA256: status.anchorSHA256,
    relayReady: status.relayConfigured,
    relayHint: status.relayConfigured
      ? '设备可通过中继连接'
      : '中继未配置 · 仅本机可配对，手机暂时无法连接',
    pending,
    devices: status.devices.map(projectDevice),
    hasActionablePending: pending.some((row) => row.confirmable)
  }
}

// Guard the confirm action: the operator taps confirm for a specific pending
// row, and we pass back the exact fingerprint that row proved. This fails closed
// if the row is not confirmable, so a racing device that proved a different key
// can never be confirmed by an accidental tap.
export function confirmArguments(row: PendingRow): { pairingId: string; publicKeySHA256: string } {
  if (!row.confirmable || !row.fingerprint) throw new Error('pairing_row_not_confirmable')
  return { pairingId: row.pairingId, publicKeySHA256: row.fingerprint }
}
