import { readdir, unlink } from 'node:fs/promises'
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


function pendingPath(base: string, recordId: string): string {
  return join(base, 'pending-receipts', recordId)
}

async function removePending(base: string, recordId: string): Promise<void> {
  try {
    await unlink(pendingPath(base, recordId))
    await syncDirectory(join(base, 'pending-receipts'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function saveReceipt(base: string, receipt: CustodyReceipt): Promise<void> {
  const directory = join(base, 'pending-receipts')
  await ensurePrivateDirectory(directory, false)
  // Publish the pending marker BEFORE the receipt/ACK. A crash can leave a
  // harmless marker without a receipt, never an ACKed pending receipt unindexed.
  if (receipt.status === 'pending') await writeFileAtomic(pendingPath(base, receipt.recordId), '')
  await writeJsonAtomic(receiptPath(base, receipt.recordId), receipt)
  if (receipt.status !== 'pending') await removePending(base, receipt.recordId)
}

export async function pendingReceipts(base: string): Promise<CustodyReceipt[]> {
  const directory = join(base, 'pending-receipts')
  await ensurePrivateDirectory(directory, false)
  const marker = join(base, 'pending-index.json')
  const version = await readJson<{ version: number }>(marker)
  if (version && version.version !== 1) throw custodyError('custody_invalid', 'pending index version is invalid')
  if (!version) {
    // One migration scan for pre-index receipts; new writers publish their
    // marker first. Stale terminal markers are checked against the receipt.
    for (const name of await readdir(join(base, 'receipts'))) {
      if (!/^[a-f0-9]{32,64}\.json$/.test(name)) continue
      const receipt = await readReceipt(base, name.slice(0, -5))
      if (receipt?.status === 'pending') await writeFileAtomic(pendingPath(base, receipt.recordId), '')
    }
    await writeJsonAtomic(marker, { version: 1 })
  }
  const pending: CustodyReceipt[] = []
  for (const recordId of await readdir(directory)) {
    if (!RECORD_ID_RE.test(recordId)) continue
    const receipt = await readReceipt(base, recordId)
    if (receipt?.status === 'pending') pending.push(receipt)
    else if (receipt) {
      try {
        await withRecordLock(base, recordId, async () => {
          const current = await readReceipt(base, recordId)
          if (current?.status === 'pending') pending.push(current)
          else if (current) await removePending(base, recordId)
        })
      } catch (error) {
        // A simultaneous release/notify owns the marker until its receipt is
        // durable. Skipping cleanup preserves its next recovery opportunity.
        if (!(error instanceof Error) || error.message !== 'upload worker is already running') throw error
      }
    }
    // A receipt may still be being committed. Never delete its early marker.
  }
  return pending
}
