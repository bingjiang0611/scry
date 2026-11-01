import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readReceipt, saveReceipt, withRecordLock } from './custody/receipts.js'
import { UploadError } from './errors.js'
import { enqueueWakeup } from './queue.js'
import { recordFilename, uploadRoot } from './storage.js'
import type { CustodyReceipt, OutboxEnvelope } from './types.js'
import { readJson, syncDirectory, writeJsonAtomic } from './util.js'

// A dead letter records one of these two custody paths, both derived from the
// record identity, so nothing else can be redriven.
const LEGACY_PAYLOAD_PREFIX = 'outbox/committed/legacy/'
const OWNED_PAYLOAD_PATHS = (name: string): string[] => [
  `outbox/committed/${name}`,
  `${LEGACY_PAYLOAD_PREFIX}${name}`
]

interface DeadLetterEntry {
  recordId: string
  sequence: number
  sha256?: string
  redactionVersion?: string
  payloadPath?: string
}

export interface RedriveResult {
  redriven: string[]
  skipped: Array<{ recordId: string; reason: string }>
}

function deadLetterName(name: string): boolean {
  return /^\d{20}-[a-f0-9]{32,64}\.json$/.test(name)
}

function parseEntry(value: unknown, name: string): DeadLetterEntry {
  const entry = value as Partial<DeadLetterEntry> | null
  if (
    !entry ||
    typeof entry.recordId !== 'string' ||
    !Number.isSafeInteger(entry.sequence) ||
    (entry.payloadPath !== undefined && typeof entry.payloadPath !== 'string')
  )
    throw new UploadError('invalid_dead_letter', name)
  return {
    recordId: entry.recordId,
    sequence: entry.sequence as number,
    sha256: typeof entry.sha256 === 'string' ? entry.sha256 : undefined,
    redactionVersion: typeof entry.redactionVersion === 'string' ? entry.redactionVersion : undefined,
    payloadPath: entry.payloadPath
  }
}

/**
 * Dead letters are a terminal state for the uploader, not for the operator.
 * Move retained records back to pending custody so the queue uploads them
 * again. Anything that cannot be proven safe to retry stays untouched.
 */
export async function redriveDeadLetters(
  workspace: string,
  options: { recordIds?: string[]; reason?: string } = {}
): Promise<RedriveResult> {
  const base = uploadRoot(workspace)
  const directory = join(base, 'dead-letter')
  const names = (await readdir(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
    throw error
  }))
    .filter(deadLetterName)
    .sort()
  const result: RedriveResult = { redriven: [], skipped: [] }
  const archived = join(directory, 'redriven')
  let workspaceId: string | undefined
  for (const entryName of names) {
    const path = join(directory, entryName)
    const entry = parseEntry(JSON.parse(await readFile(path, 'utf8')), entryName)
    if (options.recordIds && !options.recordIds.includes(entry.recordId)) continue
    const skip = (reason: string): void => {
      result.skipped.push({ recordId: entry.recordId, reason })
    }
    // The payload can only be this record's own custody file. Prefix-only checks
    // accept traversal and arbitrary retained bodies.
    const name = recordFilename(entry.sequence, entry.recordId)
    if (!entry.payloadPath || !OWNED_PAYLOAD_PATHS(name).includes(entry.payloadPath)) {
      skip('payload_unavailable')
      continue
    }
    let raw: Buffer
    try {
      raw = await readFile(join(base, entry.payloadPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      skip('payload_unavailable')
      continue
    }
    // The receipt is the authority for custody, so identity and bytes are
    // verified inside the record lock, not against the dead-letter metadata that
    // asked for the redrive. The one exception is the retained legacy variant:
    // the receipt keeps the canonical raw digest, so only the dead letter knows
    // the digest of the historical submitted bytes it kept in legacy/.
    const isLegacyVariant = entry.payloadPath.startsWith(LEGACY_PAYLOAD_PREFIX)
    const digestOfRaw = createHash('sha256').update(raw).digest('hex')
    try {
      await withRecordLock(base, entry.recordId, async () => {
        const current = await readReceipt(base, entry.recordId)
        if (current?.status !== 'dead_letter') throw new UploadError('not_dead_letter', entry.recordId)
        const expectedDigest = isLegacyVariant ? entry.sha256 : current.sha256
        if (current.sequence !== entry.sequence || !expectedDigest || expectedDigest !== digestOfRaw)
          throw new UploadError('custody_digest_mismatch', entry.recordId)
        const updated: CustodyReceipt = { ...current, status: 'pending' }
        delete updated.finishedAt
        delete updated.remoteStatus
        delete updated.wakeupQueuedAt
        await saveReceipt(base, updated)
      })
    } catch (error) {
      if (!(error instanceof UploadError)) throw error
      if (error.code !== 'not_dead_letter' && error.code !== 'custody_digest_mismatch') throw error
      skip(error.code)
      continue
    }
    if (workspaceId === undefined)
      workspaceId = (await readJson<{ workspaceId?: unknown }>(join(base, 'state.json')))?.workspaceId as string
    const envelope: OutboxEnvelope = {
      version: 1,
      sequence: entry.sequence,
      recordId: entry.recordId,
      workspaceId: workspaceId ?? '',
      redactionVersion: entry.redactionVersion ?? 'none',
      recordBytes: raw.length,
      record: raw.toString('utf8'),
      sha256: digestOfRaw
    }
    const outboxPath = join(base, 'outbox', recordFilename(entry.sequence, entry.recordId))
    await writeJsonAtomic(outboxPath, envelope)
    await syncDirectory(dirname(outboxPath))
    await mkdir(archived, { recursive: true, mode: 0o700 })
    // The dead letter moves to an audit copy instead of being deleted, so the
    // operator can still see what was redriven and why.
    await writeJsonAtomic(join(archived, entryName), {
      ...JSON.parse(await readFile(path, 'utf8')),
      redrive: { at: new Date().toISOString(), reason: options.reason ?? null }
    })
    await unlink(path)
    await syncDirectory(directory)
    result.redriven.push(entry.recordId)
  }
  if (result.redriven.length) await enqueueWakeup(workspace)
  return result
}
