import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  LEGACY_REDACTION_VERSION,
  REDACTION_VERSION
} from './constants.js'
import {
  finishCustody,
  readCustody,
  readReceipt,
  retainEnvelope,
  takeCustody
} from './custody/index.js'
import { pendingReceipts } from './custody/receipts.js'
import { validateEnvelope } from './envelope.js'
import { UploadError } from './errors.js'
import { exportPage } from './scry.js'
import {
  dataRoot,
  digest,
  recordFilename,
  uploadRoot
} from './storage.js'
import type { CustodyReceipt, OutboxEnvelope, UploadState } from './types.js'
import {
  ensurePrivateDirectory,
  exists,
  now,
  object,
  readJson,
  syncDirectory,
  writeFileAtomic,
  writeJsonAtomic
} from './util.js'

const RECORD_ID_RE = /^[a-f0-9]{32,64}$/

function statePath(workspace: string): string {
  return join(uploadRoot(workspace), 'state.json')
}

export function remainingTimeout(deadline: number, maximum: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new UploadError('upload_deadline_exhausted', 'upload deadline exhausted', true)
  return Math.min(maximum, remaining)
}

export function sourceIdentity(
  record: unknown,
  workspace: string,
  state: UploadState
): { sequence: number; recordId: string; workspaceId: string } {
  const root = object(record)
  const ws = object(root?.workspace)
  const sequence = root?.sequence
  const recordId = typeof root?.recordId === 'string' ? root.recordId : ''
  const workspaceId = typeof ws?.id === 'string' ? ws.id : ''
  const recordRoot = typeof ws?.root === 'string' ? ws.root : ''
  if (root?.schemaVersion !== 1)
    throw new UploadError('unsupported_schema_version', 'AgentTurnRecord schema unsupported')
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1 || !RECORD_ID_RE.test(recordId))
    throw new UploadError('invalid_record', 'AgentTurnRecord identity invalid')
  let sameRoot = false
  if (recordRoot) {
    try {
      sameRoot = realpathSync(recordRoot) === realpathSync(workspace)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!workspaceId || !sameRoot) throw new UploadError('workspace_mismatch', 'record workspace mismatch')
  if (state.workspaceId && state.workspaceId !== workspaceId)
    throw new UploadError('workspace_mismatch', 'workspaceId changed')
  return { sequence: Number(sequence), recordId, workspaceId }
}

export async function loadEnvelope(path: string, verifyCustody = true): Promise<OutboxEnvelope> {
  let value: unknown
  try {
    value = await readJson<unknown>(path)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new UploadError('invalid_outbox', basename(path))
  }
  const envelope = validateEnvelope(value, path)
  if (verifyCustody) {
    const base = dirname(dirname(path))
    const receipt = await readReceipt(base, envelope.recordId)
    if (receipt) {
      if (receipt.sequence !== envelope.sequence)
        throw new UploadError('custody_identity_mismatch', basename(path), true)
      const raw = await readCustody(base, receipt)
      if (envelope.redactionVersion === REDACTION_VERSION && digest(raw) !== digest(envelope.record)) {
        throw new UploadError('custody_digest_mismatch', basename(path), true)
      }
    }
  }
  return envelope
}

async function persistOutbox(
  workspace: string,
  identity: { sequence: number; recordId: string; workspaceId: string },
  record: string,
  redactionVersion = REDACTION_VERSION
): Promise<void> {
  const path = join(uploadRoot(workspace), 'outbox', recordFilename(identity.sequence, identity.recordId))
  const envelope: OutboxEnvelope = {
    version: 1,
    sequence: identity.sequence,
    recordId: identity.recordId,
    workspaceId: identity.workspaceId,
    redactionVersion,
    recordBytes: Buffer.byteLength(record),
    record,
    sha256: digest(Buffer.from(record))
  }
  const existing = await readJson<unknown>(path)
  if (existing) {
    const prior = validateEnvelope(existing, path)
    if (
      prior.recordId !== envelope.recordId ||
      prior.sequence !== envelope.sequence ||
      prior.workspaceId !== envelope.workspaceId
    )
      throw new UploadError('outbox_conflict', basename(path), true)
    if (prior.redactionVersion === LEGACY_REDACTION_VERSION) return
    if (prior.record !== record) {
      if (!isDeepStrictEqual(JSON.parse(prior.record), JSON.parse(record))) {
        throw new UploadError('outbox_conflict', basename(path), true)
      }
      await writeJsonAtomic(path, {
        ...prior,
        record,
        recordBytes: envelope.recordBytes,
        sha256: envelope.sha256
      })
    }
    return
  }
  await writeJsonAtomic(path, envelope)
}

async function markCustodyDead(workspace: string, receipt: CustodyReceipt, reason: string): Promise<void> {
  const raw = await readCustody(uploadRoot(workspace), receipt)
  await deadLetter(
    workspace,
    join(uploadRoot(workspace), 'outbox', recordFilename(receipt.sequence, receipt.recordId)),
    {
      version: 1,
      recordId: receipt.recordId,
      sequence: receipt.sequence,
      workspaceId: '',
      record: raw.toString('utf8'),
      recordBytes: raw.length,
      redactionVersion: REDACTION_VERSION,
      sha256: digest(raw)
    },
    'rejected',
    reason
  )
}

export async function enqueueCustody(workspace: string, state: UploadState, receipt: CustodyReceipt): Promise<void> {
  if (receipt.status !== 'pending') return
  const raw = await readCustody(uploadRoot(workspace), receipt)
  const path = join(uploadRoot(workspace), 'outbox', recordFilename(receipt.sequence, receipt.recordId))
  const prior = await readJson<unknown>(path)
  if (prior) {
    const envelope = validateEnvelope(prior, path)
    if (envelope.redactionVersion === LEGACY_REDACTION_VERSION) {
      if (state.workspaceId && state.workspaceId !== envelope.workspaceId) {
        throw new UploadError('workspace_mismatch', 'legacy outbox workspace changed', true)
      }
      state.workspaceId = envelope.workspaceId
      return
    }
  }
  let record: unknown
  try {
    record = JSON.parse(raw.toString('utf8'))
  } catch {
    await markCustodyDead(workspace, receipt, 'invalid_record')
    return
  }
  try {
    const identity = sourceIdentity(record, workspace, state)
    if (identity.sequence !== receipt.sequence || identity.recordId !== receipt.recordId)
      throw new UploadError('custody_identity_mismatch', 'custody identity mismatch')
    await persistOutbox(workspace, identity, raw.toString('utf8'), REDACTION_VERSION)
    state.workspaceId = identity.workspaceId
  } catch (error) {
    if (
      error instanceof UploadError &&
      [
        'invalid_record',
        'unsupported_schema_version',
        'workspace_mismatch',
        'custody_identity_mismatch'
      ].includes(error.code)
    ) {
      await markCustodyDead(workspace, receipt, error.code)
      return
    }
    throw error
  }
}

export async function enqueueCommitted(
  workspace: string,
  state: UploadState,
  expected?: {
    sequence: number
    recordId: string
    provider?: string
    sessionId?: string
  }
): Promise<void> {
  const base = uploadRoot(workspace)
  if (expected) {
    let receipt = await readReceipt(base, expected.recordId)
    if (!receipt) {
      const path = join(base, 'outbox', recordFilename(expected.sequence, expected.recordId))
      if ((await exists(path)) && !(await exists(join(dataRoot(workspace), 'records', basename(path))))) {
        receipt = await retainEnvelope(workspace, await loadEnvelope(path))
      } else {
        receipt = await takeCustody(workspace, { ...expected })
      }
    }
    if (
      !receipt ||
      receipt.sequence !== expected.sequence ||
      (expected.provider && receipt.provider !== undefined && receipt.provider !== expected.provider) ||
      (expected.sessionId && receipt.sessionId !== undefined && receipt.sessionId !== expected.sessionId)
    )
      throw new UploadError(
        'record_commit_not_custodied',
        'canonical committed record is not available',
        true
      )
    await enqueueCustody(workspace, state, receipt)
    return
  }
  for (const receipt of await pendingReceipts(base)) {
    await enqueueCustody(workspace, state, receipt)
  }
}

async function rejectedCanonicalIdentity(
  error: unknown,
  workspace: string
): Promise<{ sequence: number; recordId: string } | undefined> {
  const stderr = (error as Error & { stderr?: string }).stderr
  if (typeof stderr !== 'string') return undefined
  // This diagnostic is emitted by the pinned recorder after rejecting a
  // canonical record. A filename in an arbitrary I/O/auth error is not enough.
  const match = stderr.match(/^scry: invalid turn record: (.+\/(\d{20})-([a-f0-9]{32,64})\.json): [^\r\n]+(?:\r?\n)?$/)
  if (!match) return undefined
  const sequence = Number(match[2])
  const recordId = match[3]
  if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined
  const filename = recordFilename(sequence, recordId)
  const records = join(dataRoot(workspace), 'records')
  const namedPath = resolve(match[1])
  if (namedPath !== resolve(records, filename) && namedPath !== join(await realpath(records), filename))
    return undefined
  return { sequence, recordId }
}

async function quarantineCanonicalRecord(
  workspace: string,
  identity: { sequence: number; recordId: string },
  reason: string
): Promise<void> {
  const base = uploadRoot(workspace)
  const records = join(dataRoot(workspace), 'records')
  const source = join(records, recordFilename(identity.sequence, identity.recordId))
  const sourceReal = await realpath(source)
  if (dirname(sourceReal) !== await realpath(records)) throw new UploadError('record_path_escape', 'record path escapes data records directory')
  const raw = await readFile(source)
  const payloadDirectory = join(base, 'dead-letter', 'payloads')
  await ensurePrivateDirectory(payloadDirectory, false)
  const suffix = recordFilename(identity.sequence, identity.recordId)
  await writeFileAtomic(join(payloadDirectory, suffix), raw)
  await writeJsonAtomic(join(base, 'dead-letter', `${Date.now()}-export-${suffix}`), {
    version: 1,
    sequence: identity.sequence,
    recordId: identity.recordId,
    reason,
    payloadPath: `payloads/${suffix}`,
    failedAt: now()
  })
  const receipt = await readReceipt(base, identity.recordId)
  if (receipt && receipt.sequence === identity.sequence) await markCustodyDead(workspace, receipt, reason)
}

async function quarantineDiscoveryRecord(
  workspace: string,
  record: unknown,
  sequence: number,
  recordId: string,
  reason: string
): Promise<void> {
  const base = uploadRoot(workspace)
  const payloadDirectory = join(base, 'dead-letter', 'payloads')
  await ensurePrivateDirectory(payloadDirectory, false)
  const suffix = RECORD_ID_RE.test(recordId) ? recordFilename(sequence, recordId) : `${Date.now()}-${randomUUID()}.json`
  const payloadPath = join(payloadDirectory, suffix)
  const raw = JSON.stringify(record)
  await writeFileAtomic(payloadPath, raw)
  await writeJsonAtomic(join(base, 'dead-letter', `${Date.now()}-discovery-${suffix}`), {
    version: 1,
    sequence,
    recordId,
    reason,
    payloadPath: `payloads/${suffix}`,
    failedAt: now()
  })
}

export async function enqueueSnapshot(
  workspace: string,
  state: UploadState,
  env: NodeJS.ProcessEnv,
  deadline: number
): Promise<number> {
  let cursor = state.enqueuedThrough
  let snapshot: number | undefined
  let count = 0
  while (true) {
    let page: Awaited<ReturnType<typeof exportPage>>
    try {
      page = await exportPage(workspace, cursor, snapshot, remainingTimeout(deadline, 30_000), env)
    } catch (error) {
      const rejected = await rejectedCanonicalIdentity(error, workspace)
      if (!rejected || rejected.sequence <= cursor) throw error
      // A failed page may contain good records before the bad one. Ask the
      // recorder for one item, so we never jump over those records or gaps.
      try {
        page = await exportPage(workspace, cursor, snapshot, remainingTimeout(deadline, 30_000), env, 1)
      } catch (singleError) {
        const first = await rejectedCanonicalIdentity(singleError, workspace)
        if (!first || first.sequence <= cursor || (snapshot !== undefined && first.sequence > snapshot))
          throw singleError
        await quarantineCanonicalRecord(workspace, first, 'export_rejected_record')
        state.enqueuedThrough = first.sequence
        await writeJsonAtomic(statePath(workspace), state)
        cursor = first.sequence
        count++
        continue
      }
    }
    if (snapshot === undefined) snapshot = page.snapshotMaxSequence
    if (snapshot !== page.snapshotMaxSequence)
      throw new UploadError('export_snapshot_changed', 'snapshot changed', true)
    let previous = cursor
    for (const record of page.records) {
      const value = object(record)
      const sequence = value?.sequence
      const recordId = typeof value?.recordId === 'string' ? value.recordId : ''
      if (!Number.isSafeInteger(sequence) || Number(sequence) <= previous || Number(sequence) > snapshot) {
        // Without a trustworthy sequence there is no safe cursor advance. Keep
        // the strict fail-closed behavior for corrupt export ordering.
        throw new UploadError('export_sequence_invalid', 'export sequence invalid', true)
      }
      if (!RECORD_ID_RE.test(recordId)) {
        throw new UploadError('invalid_record', 'export record identity invalid')
      }
      const custody = await readReceipt(uploadRoot(workspace), recordId)
      if (custody) {
        if (custody.sequence !== sequence) throw new UploadError('custody_identity_mismatch', recordId, true)
        await enqueueCustody(workspace, state, custody)
      } else {
        try {
          const identity = sourceIdentity(record, workspace, state)
          // Discovery owns canonical bytes before advancing its cursor, just as
          // record notifications do. An export projection is not a receipt.
          const retained = await takeCustody(workspace, { sequence: identity.sequence, recordId })
          state.workspaceId = identity.workspaceId
          await enqueueCustody(workspace, state, retained)
        } catch (error) {
          if (
            !(error instanceof UploadError) ||
            !['invalid_record', 'unsupported_schema_version', 'workspace_mismatch', 'custody_identity_mismatch'].includes(
              error.code
            )
          )
            throw error
          // A valid sequence/recordId lets us advance past one poisoned export
          // item. Preserve the exact JSON received and its provenance instead of
          // starving already queued records or silently accepting its identity.
          await quarantineDiscoveryRecord(workspace, record, Number(sequence), recordId, error.code)
        }
      }
      previous = Number(sequence)
      state.enqueuedThrough = previous
      await writeJsonAtomic(statePath(workspace), state)
      count++
    }
    if (page.nextCursor !== previous)
      throw new UploadError('export_cursor_mismatch', 'export cursor mismatch', true)
    if (page.hasMore && page.nextCursor <= cursor)
      throw new UploadError('export_cursor_stalled', 'export cursor stalled', true)
    state.enqueuedThrough = page.nextCursor
    await writeJsonAtomic(statePath(workspace), state)
    cursor = page.nextCursor
    if (!page.hasMore) return count
  }
}

export async function outboxPaths(workspace: string): Promise<string[]> {
  return (await readdir(join(uploadRoot(workspace), 'outbox')))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(uploadRoot(workspace), 'outbox', name))
}

export async function deadLetter(
  workspace: string,
  path: string,
  envelope: OutboxEnvelope,
  status: string,
  reason: string
): Promise<void> {
  const base = uploadRoot(workspace)
  const retained = await retainEnvelope(workspace, envelope)
  const legacyVariant =
    envelope.redactionVersion === LEGACY_REDACTION_VERSION && retained.sha256 !== digest(envelope.record)
  await writeJsonAtomic(join(base, 'dead-letter', recordFilename(envelope.sequence, envelope.recordId)), {
    recordId: envelope.recordId,
    sequence: envelope.sequence,
    sha256: digest(Buffer.from(envelope.record)),
    redactionVersion: envelope.redactionVersion,
    payloadPath: `outbox/committed/${legacyVariant ? 'legacy/' : ''}${recordFilename(envelope.sequence, envelope.recordId)}`,
    remoteStatus: status,
    reason: [
      'oversize_record',
      'invalid_record',
      'unsupported_schema_version',
      'workspace_mismatch',
      'custody_identity_mismatch',
      'report_timeout_exhausted'
    ].includes(reason)
      ? reason
      : `remote_${status}`,
    failedAt: now()
  })
  await finishCustody(workspace, envelope, 'dead_letter', status)
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await syncDirectory(dirname(path))
}
