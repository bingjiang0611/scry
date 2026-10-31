import { opendir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { UploadError } from '../errors.js'
import { receiptPath } from '../storage.js'
import type { CustodyReceipt } from '../types.js'
import { acquireDirectoryLock, ensurePrivateDirectory, readJson, syncDirectory, writeFileAtomic, writeJsonAtomic } from '../util.js'

const RECORD_ID_RE = /^[a-f0-9]{32,64}$/
export const SHA256_RE = /^[a-f0-9]{64}$/
const CUSTODY_STATUSES = new Set<CustodyReceipt['status']>([
  'pending',
  'skipped_disabled',
  'uploaded',
  'dead_letter'
])

export function custodyError(code: string, message: string, cause?: unknown): UploadError {
  return new UploadError(code, message, true, undefined, cause === undefined ? undefined : { cause })
}

export function validateRecordIdentity(recordId: string, sequence?: number): void {
  if (!RECORD_ID_RE.test(recordId)) throw custodyError('custody_identity_invalid', 'recordId is invalid')
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1))
    throw custodyError('custody_identity_invalid', 'sequence is invalid')
}

export function validateReceipt(value: unknown, recordId: string): CustodyReceipt {
  validateRecordIdentity(recordId)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw custodyError('custody_invalid', 'custody receipt is invalid')
  const receipt = value as Partial<CustodyReceipt>
  if (receipt.version !== 1 || receipt.recordId !== recordId)
    throw custodyError('custody_identity_mismatch', 'receipt identity mismatch')
  if (!Number.isSafeInteger(receipt.sequence) || Number(receipt.sequence) < 1)
    throw custodyError('custody_identity_invalid', 'receipt sequence is invalid')
  validateRecordIdentity(recordId, receipt.sequence)
  if (typeof receipt.sha256 !== 'string' || !SHA256_RE.test(receipt.sha256))
    throw custodyError('custody_invalid', 'receipt sha256 is invalid')
  if (typeof receipt.status !== 'string' || !CUSTODY_STATUSES.has(receipt.status as CustodyReceipt['status']))
    throw custodyError('custody_status_invalid', 'receipt status is invalid')
  for (const timestamp of [receipt.bodyPruneStartedAt, receipt.bodyPrunedAt]) {
    if (timestamp !== undefined &&
        (receipt.status !== 'uploaded' || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))))
      throw custodyError('custody_invalid', 'pruned receipt is invalid')
  }
  return receipt as CustodyReceipt
}

function lockPath(base: string, recordId: string): string {
  return join(base, 'receipts', `.${recordId}.standalone.lock`)
}

export async function withRecordLock<T>(base: string, recordId: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireDirectoryLock(lockPath(base, recordId))
  try {
    return await action()
  } finally {
    await release()
  }
}

async function readReceiptFile(base: string, recordId: string): Promise<CustodyReceipt | null> {
  const value = await readJson<unknown>(receiptPath(base, recordId))
  return value === null ? null : validateReceipt(value, recordId)
}

export async function readReceipt(base: string, recordId: string): Promise<CustodyReceipt | null> {
  validateRecordIdentity(recordId)
  try {
    return await readReceiptFile(base, recordId)
  } catch (error) {
    if (error instanceof UploadError) throw error
    throw custodyError('custody_invalid', 'custody receipt cannot be read', error)
  }
}


const INDEXED_STATUSES = ['pending', 'skipped_disabled'] as const
type IndexedStatus = typeof INDEXED_STATUSES[number]

function indexKind(status: IndexedStatus): string {
  return status === 'pending' ? 'pending' : 'held'
}

function indexDirectory(base: string, status: IndexedStatus): string {
  return join(base, `${indexKind(status)}-receipts`)
}

async function removeIndexMarker(base: string, status: IndexedStatus, recordId: string): Promise<void> {
  const directory = indexDirectory(base, status)
  try {
    await unlink(join(directory, recordId))
    await syncDirectory(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function saveReceipt(base: string, receipt: CustodyReceipt): Promise<void> {
  // Publish the applicable marker BEFORE its receipt. A crash may leave a stale
  // marker, never a durable pending/held receipt missing from its active index.
  for (const status of INDEXED_STATUSES) {
    if (receipt.status !== status) continue
    const directory = indexDirectory(base, status)
    await ensurePrivateDirectory(directory, false)
    await writeFileAtomic(join(directory, receipt.recordId), '')
  }
  await writeJsonAtomic(receiptPath(base, receipt.recordId), receipt)
  for (const status of INDEXED_STATUSES)
    if (receipt.status !== status) await removeIndexMarker(base, status, receipt.recordId)
}

async function ensureReceiptIndex(base: string, status: IndexedStatus): Promise<string> {
  const directory = indexDirectory(base, status)
  await ensurePrivateDirectory(directory, false)
  const marker = join(base, `${indexKind(status)}-index.json`)
  const version = await readJson<{ version: number }>(marker)
  if (version && version.version !== 1) throw custodyError('custody_invalid', `${indexKind(status)} index version is invalid`)
  if (!version) {
    // One migration scan per index; later wakeups never scan archived receipts.
    // New writers publish their marker first, and readers revalidate its status.
    for await (const entry of await opendir(join(base, 'receipts'))) {
      if (!/^[a-f0-9]{32,64}\.json$/.test(entry.name)) continue
      const receipt = await readReceipt(base, entry.name.slice(0, -5))
      if (receipt?.status === status) await writeFileAtomic(join(directory, receipt.recordId), '')
    }
    await writeJsonAtomic(marker, { version: 1 })
  }
  return directory
}

async function indexedReceipt(base: string, status: IndexedStatus, recordId: string): Promise<CustodyReceipt | null> {
  const receipt = await readReceipt(base, recordId)
  if (receipt?.status === status) return receipt
  // A receipt may still be being committed. Never delete its early marker.
  if (!receipt) return null
  try {
    return await withRecordLock(base, recordId, async () => {
      const current = await readReceipt(base, recordId)
      if (current?.status === status) return current
      if (current) await removeIndexMarker(base, status, recordId)
      return null
    })
  } catch (error) {
    // A simultaneous status transition owns the marker until its receipt is
    // durable. Skipping cleanup preserves its next recovery opportunity.
    if (!(error instanceof Error) || error.message !== 'upload worker is already running') throw error
    return null
  }
}

export async function pendingReceipts(base: string): Promise<CustodyReceipt[]> {
  const directory = await ensureReceiptIndex(base, 'pending')
  const pending: CustodyReceipt[] = []
  for (const recordId of await readdir(directory)) {
    if (!RECORD_ID_RE.test(recordId)) continue
    const receipt = await indexedReceipt(base, 'pending', recordId)
    if (receipt) pending.push(receipt)
  }
  return pending
}

export async function hasHeldReceipts(base: string): Promise<boolean> {
  const directory = await ensureReceiptIndex(base, 'skipped_disabled')
  // Snapshot names before stale-marker cleanup mutates this directory. Health
  // stops at the first held receipt, without reading retained record bodies.
  for (const recordId of await readdir(directory)) {
    if (!RECORD_ID_RE.test(recordId)) continue
    if (await indexedReceipt(base, 'skipped_disabled', recordId)) return true
  }
  return false
}
