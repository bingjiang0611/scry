import { open, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { validateEnvelope } from '../envelope.js'
import { UploadError } from '../errors.js'
import { recordUploadDisabled } from '../scry.js'
import {
  assertLegacyLocksMigrated,
  committedPath,
  dataRoot,
  digest,
  prepareUploadRoot,
  receiptPath,
  recordFilename,
  uploadRoot
} from '../storage.js'
import type { CustodyReceipt, OutboxEnvelope, RecordCommittedNotification, UploadState } from '../types.js'
import {
  now,
  readJson,
  syncDirectory,
  writeFileAtomic,
  writeJsonAtomic
} from '../util.js'

import { SHA256_RE, custodyError, pendingReceipts, readReceipt, saveReceipt, validateReceipt, validateRecordIdentity, withRecordLock } from './receipts.js'
export { readReceipt } from './receipts.js'

export async function readCustody(base: string, receipt: CustodyReceipt): Promise<Buffer> {
  const checked = validateReceipt(receipt, receipt.recordId)
  const path = committedPath(base, checked.sequence, checked.recordId)
  let raw: Buffer
  try {
    raw = await readFile(path)
  } catch (error) {
    throw custodyError('custody_missing', 'custody bytes are missing', error)
  }
  if (digest(raw) !== checked.sha256)
    throw new UploadError('custody_digest_mismatch', 'custody bytes do not match receipt', true)
  return raw
}

async function markDisabled(base: string, receipt: CustodyReceipt): Promise<CustodyReceipt> {
  let current = receipt
  if (current.status === 'pending') {
    current = { ...current, status: 'skipped_disabled' }
    await saveReceipt(base, current)
  }
  const line =
    JSON.stringify({
      event: 'skipped_disabled',
      recordId: current.recordId,
      sequence: current.sequence,
      at: now()
    }) + '\n'
  const path = join(base, 'skipped_disabled.jsonl')
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(line)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(base)
  return current
}

async function prepare(workspace: string): Promise<string> {
  const base = await prepareUploadRoot(workspace)
  await assertLegacyLocksMigrated(base)
  return base
}

type CustodyNotification = Pick<RecordCommittedNotification, 'recordId' | 'sequence'> &
  Partial<RecordCommittedNotification>

function eventIdentity(event: CustodyNotification): void {
  validateRecordIdentity(event.recordId, event.sequence)
}

export async function takeCustody(
  workspace: string,
  event: CustodyNotification,
  disabled = false
): Promise<CustodyReceipt> {
  eventIdentity(event)
  const data = dataRoot(workspace)
  const base = await prepare(workspace)
  const expectedName = recordFilename(event.sequence, event.recordId)
  const recordPath = event.recordPath ?? `records/${expectedName}`
  if (recordPath !== `records/${expectedName}`)
    throw new UploadError('record_path_mismatch', 'recordPath does not identify the committed record')
  if (event.sha256 !== undefined && (!SHA256_RE.test(event.sha256) || event.sha256.length !== 64))
    throw new UploadError('invalid_sha256', 'sha256 is invalid')

  return await withRecordLock(base, event.recordId, async () => {
    const policy = await readJson<UploadState>(join(base, 'state.json'))
    const explicitlyDisabled = disabled || policy?.uploadEnabled === false
    const beforeEnable = event.sequence <= (policy?.disabledThrough ?? 0)
    const existing = await readReceipt(base, event.recordId)
    if (existing) {
      if (existing.sequence !== event.sequence)
        throw new UploadError('custody_identity_mismatch', 'receipt identity mismatch')
      if (existing.bodyPruneStartedAt || existing.bodyPrunedAt) {
        if (event.sha256 !== undefined && event.sha256 !== existing.sha256)
          throw new UploadError('notification_digest_mismatch', 'notification digest mismatch')
        await syncDirectory(dirname(receiptPath(base, existing.recordId)))
        return existing
      }
      const raw = await readCustody(base, existing)
      if (event.sha256 !== undefined && digest(raw) !== event.sha256)
        throw new UploadError('notification_digest_mismatch', 'notification digest mismatch')
      await syncDirectory(dirname(committedPath(base, existing.sequence, existing.recordId)))
      await syncDirectory(dirname(receiptPath(base, existing.recordId)))
      return explicitlyDisabled || (beforeEnable && !existing.releasedAt)
        ? await markDisabled(base, existing)
        : existing
    }

    const source = join(data, recordPath)
    const recordsDirectory = join(data, 'records')
    const sourceReal = await realpath(source)
    const recordsReal = await realpath(recordsDirectory)
    if (dirname(sourceReal) !== recordsReal)
      throw new UploadError('record_path_escape', 'record path escapes data records directory')
    const raw = await readFile(source)
    const sha256 = digest(raw)
    if (event.sha256 !== undefined && sha256 !== event.sha256)
      throw new UploadError('notification_digest_mismatch', 'notification digest mismatch')

    const target = committedPath(base, event.sequence, event.recordId)
    try {
      const prior = await readFile(target)
      if (!prior.equals(raw)) throw new UploadError('custody_conflict', 'committed custody bytes conflict')
      await syncDirectory(dirname(target))
    } catch (error) {
      if (error instanceof UploadError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await writeFileAtomic(target, raw)
    }
    const receipt: CustodyReceipt = {
      version: 1,
      recordId: event.recordId,
      sequence: event.sequence,
      sha256,
      ...(event.provider === undefined ? {} : { provider: event.provider }),
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      status: explicitlyDisabled || beforeEnable || await recordUploadDisabled(data, event.recordId)
        ? 'skipped_disabled' : 'pending',
      takenAt: now()
    }
    await saveReceipt(base, receipt)
    return receipt.status === 'skipped_disabled' ? await markDisabled(base, receipt) : receipt
  })
}

function envelopeIdentity(envelope: OutboxEnvelope): void {
  validateRecordIdentity(envelope.recordId, envelope.sequence)
  if (typeof envelope.record !== 'string') throw new UploadError('invalid_outbox', 'outbox record is invalid')
}

async function retainLegacyVariant(base: string, envelope: OutboxEnvelope): Promise<void> {
  const target = join(
    base,
    'outbox',
    'committed',
    'legacy',
    recordFilename(envelope.sequence, envelope.recordId)
  )
  const raw = Buffer.from(envelope.record)
  let handle
  try {
    handle = await open(target, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFileAtomic(target, raw)
    return
  }
  try {
    if (!(await handle.readFile()).equals(raw))
      throw custodyError('custody_conflict', 'retained legacy payload differs')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(dirname(target))
}

export async function retainEnvelope(
  workspace: string,
  envelope: OutboxEnvelope,
  disabled = false
): Promise<CustodyReceipt> {
  envelopeIdentity(envelope)
  const base = await prepare(workspace)
  return await withRecordLock(base, envelope.recordId, async () => {
    const existing = await readReceipt(base, envelope.recordId)
    if (existing) {
      if (existing.sequence !== envelope.sequence)
        throw new UploadError('custody_identity_mismatch', 'receipt identity mismatch')
      const raw = await readCustody(base, existing)
      if (envelope.redactionVersion === 'agent-turn-v1' && !raw.equals(Buffer.from(envelope.record))) {
        // Canonical receipt bytes and historical submitted bytes are distinct
        // evidence. Preserve both before any terminal outbox deletion.
        await retainLegacyVariant(base, envelope)
      }
      return disabled ? await markDisabled(base, existing) : existing
    }
    const raw = Buffer.from(envelope.record, 'utf8')
    const target = committedPath(base, envelope.sequence, envelope.recordId)
    try {
      const prior = await readFile(target)
      if (!prior.equals(raw)) throw new UploadError('custody_conflict', 'committed custody bytes conflict')
      await syncDirectory(dirname(target))
    } catch (error) {
      if (error instanceof UploadError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await writeFileAtomic(target, raw)
    }
    const receipt: CustodyReceipt = {
      version: 1,
      recordId: envelope.recordId,
      sequence: envelope.sequence,
      sha256: digest(raw),
      status: 'pending',
      takenAt: now()
    }
    await saveReceipt(base, receipt)
    return disabled ? await markDisabled(base, receipt) : receipt
  })
}

export async function releaseDisabled(workspace: string, recordId: string): Promise<void> {
  validateRecordIdentity(recordId)
  const base = await prepare(workspace)
  await withRecordLock(base, recordId, async () => {
    const receipt = await readReceipt(base, recordId)
    if (!receipt) throw new UploadError('record_not_disabled', 'record is not disabled')
    await readCustody(base, receipt)
    if (receipt.status === 'pending' && receipt.releasedAt) return
    if (receipt.status !== 'skipped_disabled')
      throw new UploadError('record_not_disabled', 'record is not disabled')
    const updated: CustodyReceipt = { ...receipt, status: 'pending', releasedAt: now() }
    delete updated.wakeupQueuedAt
    await saveReceipt(base, updated)
  })
}

export async function finishCustody(
  workspace: string,
  envelope: OutboxEnvelope,
  status: 'uploaded' | 'dead_letter',
  remoteStatus?: string
): Promise<void> {
  envelopeIdentity(envelope)
  const base = uploadRoot(workspace)
  const initial = await readReceipt(base, envelope.recordId)
  if (!initial) throw new UploadError('custody_missing', 'terminal status requires a custody receipt')
  await withRecordLock(base, envelope.recordId, async () => {
    const receipt = await readReceipt(base, envelope.recordId)
    if (!receipt) throw new UploadError('custody_missing', 'custody receipt disappeared')
    if (receipt.sequence !== envelope.sequence)
      throw new UploadError('custody_identity_mismatch', 'receipt sequence mismatch', true)
    const raw = await readCustody(base, receipt)
    if (envelope.redactionVersion === 'none' && !raw.equals(Buffer.from(envelope.record, 'utf8')))
      throw new UploadError('custody_digest_mismatch', 'envelope differs from custody', true)
    const updated: CustodyReceipt = { ...receipt, status, finishedAt: now() }
    if (remoteStatus !== undefined) updated.remoteStatus = remoteStatus
    await saveReceipt(base, updated)
  })
}

async function loadPendingEnvelope(path: string): Promise<OutboxEnvelope> {
  const envelope = validateEnvelope(await readJson<unknown>(path), path)
  const base = dirname(dirname(path))
  const receipt = await readReceipt(base, envelope.recordId)
  if (receipt) {
    if (receipt.sequence !== envelope.sequence)
      throw custodyError('custody_identity_mismatch', 'receipt sequence mismatch')
    const raw = await readCustody(base, receipt)
    if (envelope.redactionVersion === 'none' && !raw.equals(Buffer.from(envelope.record)))
      throw custodyError('custody_digest_mismatch', 'envelope differs from custody')
  }
  return envelope
}

export async function pausePending(workspace: string): Promise<void> {
  const base = await prepare(workspace)
  const outbox = join(base, 'outbox')
  const entries = await readdir(outbox, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const id = entry.name.match(/^\d{20}-([a-f0-9]{32,64})\.json$/)?.[1]
    const existing = id ? await readReceipt(base, id) : null
    if (existing && existing.status !== 'pending') continue
    await retainEnvelope(workspace, await loadPendingEnvelope(join(outbox, entry.name)))
  }
  for (const receipt of await pendingReceipts(base)) {
    const recordId = receipt.recordId
    if (receipt.status === 'pending') {
      await withRecordLock(base, recordId, async () => {
        const current = await readReceipt(base, recordId)
        if (current?.status === 'pending') {
          await readCustody(base, current)
          await markDisabled(base, current)
        }
      })
    }
  }
}

export async function pruneAckedBodies(workspace: string, nowMs = Date.now()): Promise<number> {
  const base = await prepare(workspace)
  const cutoff = nowMs - 30 * 24 * 60 * 60 * 1_000
  let pruned = 0
  for (const name of await readdir(join(base, 'receipts'))) {
    if (!/^[a-f0-9]{32,64}\.json$/.test(name)) continue
    const recordId = name.slice(0, -5)
    const candidate = await readReceipt(base, recordId)
    if (!candidate || candidate.status !== 'uploaded' || candidate.bodyPrunedAt || !candidate.finishedAt) continue
    if (!Number.isFinite(Date.parse(candidate.finishedAt)) || Date.parse(candidate.finishedAt) > cutoff) continue
    await withRecordLock(base, recordId, async () => {
      const receipt = await readReceipt(base, recordId)
      if (!receipt || receipt.status !== 'uploaded' || receipt.bodyPrunedAt || !receipt.finishedAt) return
      if (!Number.isFinite(Date.parse(receipt.finishedAt)) || Date.parse(receipt.finishedAt) > cutoff) return
      const retiring = { ...receipt, bodyPruneStartedAt: receipt.bodyPruneStartedAt ?? new Date(nowMs).toISOString() }
      // Persist retirement authority before unlink. A crash must not turn an
      // intentionally retired ACKed body into an unexplained missing body.
      await saveReceipt(base, retiring)
      const canonical = committedPath(base, receipt.sequence, recordId)
      const legacy = join(base, 'outbox', 'committed', 'legacy', recordFilename(receipt.sequence, recordId))
      for (const path of [canonical, legacy]) {
        try {
          await unlink(path)
          await syncDirectory(dirname(path))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      // Only a definitively ACKed receipt may survive without its body.
      // This durable marker distinguishes retirement from unexpected loss.
      await saveReceipt(base, { ...retiring, bodyPrunedAt: new Date(nowMs).toISOString() })
      pruned++
    })
  }
  return pruned
}

export async function pruneAckedBodiesIfDue(workspace: string, nowMs = Date.now()): Promise<number> {
  const base = await prepare(workspace)
  const path = join(base, 'retention.json')
  const previous = await readJson<{ completedAt: number }>(path)
  if (previous && nowMs - previous.completedAt < 24 * 60 * 60 * 1_000) return 0
  const pruned = await pruneAckedBodies(workspace, nowMs)
  await writeJsonAtomic(path, { version: 1, completedAt: nowMs })
  return pruned
}

export async function markWakeupQueued(workspace: string, sequence: number, recordId: string): Promise<void> {
  validateRecordIdentity(recordId, sequence)
  const base = uploadRoot(workspace)
  await withRecordLock(base, recordId, async () => {
    const receipt = await readReceipt(base, recordId)
    if (!receipt) throw new UploadError('custody_missing', 'custody receipt is missing')
    if (receipt.sequence !== sequence)
      throw new UploadError('custody_identity_mismatch', 'receipt identity mismatch')
    if (receipt.status !== 'pending') return
    await saveReceipt(base, { ...receipt, wakeupQueuedAt: now() })
  })
}
