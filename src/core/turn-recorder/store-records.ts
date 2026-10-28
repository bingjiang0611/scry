import { join, resolve } from 'node:path'
import { type ToolContentRef } from '../../shared/tool-content.js'
import { type AgentTurnRecord, validateAgentTurnRecord } from '../../shared/turn-record.js'
import { type ExportPage } from './store-shared.js'
import { copyRecorderContent } from './content-store.js'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { archiveJournal, archivePathsOverlap, readArchiveState } from './store-archive-state.js'
import { addContentRefs } from './store-content.js'
import { recordFiles, readRecordFile, invalidateRecordIndex } from './store-shared.js'
import { mkdirDurable, syncDirectory, withDirectoryLock, writeJsonAtomic } from './io.js'

export async function findRecordById(dataRoot: string, recordId: string): Promise<AgentTurnRecord | undefined> {
  const match = (await recordFiles(dataRoot)).find((file) => file.recordId === recordId)
  return match ? await readRecordFile(join(dataRoot, 'records', match.name)) : undefined
}

export async function recordStoreStamp(dataRoot: string): Promise<{ count: number; maxSequence: number }> {
  const files = await recordFiles(dataRoot)
  return { count: files.length, maxSequence: files.at(-1)?.sequence ?? 0 }
}

export async function commitRecord(
  dataRoot: string,
  draft: Omit<AgentTurnRecord, 'sequence'>
): Promise<{ status: 'committed' | 'duplicate'; record: AgentTurnRecord }> {
  if (!/^[a-f0-9]{32,64}$/.test(draft.recordId)) throw new Error('recordId must be a 32-64 character lowercase hex digest')
  return withDirectoryLock(join(dataRoot, 'locks', 'commit.lock'), async () => {
    if (await archiveJournal(dataRoot)) {
      throw new Error('pending archive must be resumed before committing another record')
    }
    // Allocation and duplicate detection never trust a derived projection.
    const files = await recordFiles(dataRoot, { bypassIndex: true })
    const duplicate = files.find((file) => file.recordId === draft.recordId)
    if (duplicate) {
      return { status: 'duplicate' as const, record: await readRecordFile(join(dataRoot, 'records', duplicate.name)) }
    }
    // The allocator must clear the archive floor, otherwise archiving every live record would
    // restart numbering at 1 and collide with sequences that were already issued. Duplicate
    // detection only scans live records: archiving is therefore restricted to finalized turns
    // (and, when a commit hook exists, acknowledged ones), which cannot be re-committed.
    const archivedThrough = (await readArchiveState(dataRoot))?.archivedThrough ?? 0
    const sequence = Math.max(files.at(-1)?.sequence ?? 0, archivedThrough) + 1
    const record: AgentTurnRecord = { ...draft, sequence }
    const validation = validateAgentTurnRecord(record)
    if (!validation.ok) {
      const detail = validation.issues.slice(0, 4).map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      throw new Error(`refusing to commit invalid turn record: ${detail}`)
    }
    const filename = `${String(sequence).padStart(20, '0')}-${record.recordId}.json`
    await writeJsonAtomic(join(dataRoot, 'records', filename), record)
    invalidateRecordIndex(dataRoot)
    return { status: 'committed' as const, record }
  })
}

export async function exportRecords(
  dataRoot: string,
  options: { after?: number; limit?: number; snapshotMaxSequence?: number } = {}
): Promise<ExportPage> {
  const after = Math.max(0, Math.floor(options.after ?? 0))
  const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 100)))
  const files = await recordFiles(dataRoot)
  const currentMax = files.at(-1)?.sequence ?? 0
  const snapshotMaxSequence = Math.min(options.snapshotMaxSequence ?? currentMax, currentMax)
  const selected = files.filter((file) => file.sequence > after && file.sequence <= snapshotMaxSequence).slice(0, limit)
  const records: AgentTurnRecord[] = []
  for (const file of selected) records.push(await readRecordFile(join(dataRoot, 'records', file.name)))
  const nextCursor = records.at(-1)?.sequence ?? after
  return {
    records,
    nextCursor,
    hasMore: files.some((file) => file.sequence > nextCursor && file.sequence <= snapshotMaxSequence),
    snapshotMaxSequence
  }
}

export interface RecordExportBundle {
  target: string
  records: number
  contents: number
  snapshotMaxSequence: number
}

export async function exportRecordBundle(dataRoot: string, target: string): Promise<RecordExportBundle> {
  const canonicalRoot = resolve(dataRoot)
  const canonicalTarget = resolve(target)
  if (archivePathsOverlap(canonicalRoot, canonicalTarget)) {
    throw new Error('export target must not overlap the recorder store')
  }
  const files = await recordFiles(dataRoot)
  const snapshotMaxSequence = files.at(-1)?.sequence ?? 0
  const parent = resolve(canonicalTarget, '..')
  await mkdir(parent, { recursive: true })
  const temp = await mkdtemp(join(parent, '.scry-export-'))
  try {
    const recordsDir = join(temp, 'records')
    await mkdirDurable(recordsDir)
    const refs = new Map<string, ToolContentRef>()
    for (const file of files) {
      const record = await readRecordFile(join(dataRoot, 'records', file.name))
      await writeJsonAtomic(join(recordsDir, file.name), record)
      addContentRefs(refs, record)
    }
    for (const ref of refs.values()) await copyRecorderContent(dataRoot, temp, ref)
    await writeJsonAtomic(join(temp, 'manifest.json'), {
      schemaVersion: 1,
      kind: 'scry-recorder-export',
      createdAt: new Date().toISOString(),
      snapshotMaxSequence,
      records: files.map((file) => ({ name: file.name, sequence: file.sequence, recordId: file.recordId })),
      contents: [...refs.values()].sort((left, right) => left.sha256.localeCompare(right.sha256))
    })
    await syncDirectory(temp)
    await rename(temp, canonicalTarget)
    await syncDirectory(parent)
    return { target: canonicalTarget, records: files.length, contents: refs.size, snapshotMaxSequence }
  } catch (error) {
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}

export async function listRecords(dataRoot: string): Promise<AgentTurnRecord[]> {
  const files = await recordFiles(dataRoot)
  const records: AgentTurnRecord[] = []
  for (const file of files) records.push(await readRecordFile(join(dataRoot, 'records', file.name)))
  return records
}

export async function showRecord(dataRoot: string, selector: string): Promise<AgentTurnRecord | null> {
  const files = await recordFiles(dataRoot)
  const sequence = /^\d+$/.test(selector) ? Number(selector) : undefined
  const match = files.find((file) => file.recordId === selector || file.sequence === sequence)
  return match ? await readRecordFile(join(dataRoot, 'records', match.name)) : null
}

export async function lastRecordVersion(dataRoot: string): Promise<string | null> {
  const files = await recordFiles(dataRoot)
  const newest = files.at(-1)
  if (!newest) return null
  try {
    return (await readRecordFile(join(dataRoot, 'records', newest.name))).recorderVersion
  } catch {
    return null
  }
}

export async function verifyStore(dataRoot: string): Promise<{ ok: boolean; records: number; errors: string[]; archivedThrough: number }> {
  // Integrity verification always bypasses disposable projections and scans canonical filenames.
  const files = await recordFiles(dataRoot, { bypassIndex: true })
  const errors: string[] = []
  // An archived prefix is only acceptable when an archive operation recorded the floor.
  let archivedThrough = 0
  try {
    archivedThrough = (await readArchiveState(dataRoot))?.archivedThrough ?? 0
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const journal = await archiveJournal(dataRoot)
    if (journal) errors.push(`pending archive journal: ${journal.transactionId}`)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  let previous = archivedThrough
  const ids = new Set<string>()
  for (const file of files) {
    if (file.sequence <= previous) errors.push(`non-monotonic sequence: ${file.name}`)
    if (file.sequence !== previous + 1) errors.push(`sequence gap before: ${file.name}`)
    previous = file.sequence
    if (ids.has(file.recordId)) errors.push(`duplicate recordId: ${file.recordId}`)
    ids.add(file.recordId)
    try {
      await readRecordFile(join(dataRoot, 'records', file.name))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { ok: errors.length === 0, records: files.length, errors, archivedThrough }
}
