import { createHash, randomUUID } from 'node:crypto'
import { readFile, lstat, realpath, link, rm } from 'node:fs/promises'
import { join, relative, isAbsolute, sep, resolve, basename } from 'node:path'
import { type ToolContentRef, isToolContentRef } from '../../shared/tool-content.js'
import { type AgentTurnRecord } from '../../shared/turn-record.js'
import { readRecorderContent, copyRecorderContent } from './content-store.js'
import { withDirectoryLock, syncDirectory, mkdirDurable, listFiles, writeJsonAtomic, exclusiveWriteTempPath, writeFileAtomicExclusive } from './io.js'
import { RECORDER_VERSION } from './store.js'
import { parseRecordName, recordFiles, existingFile, existingPath, readRecordFile, collectContentRefs, invalidateRecordIndex } from './store-index.js'


export interface ArchiveState {
  schemaVersion: 1
  /** Highest sequence intentionally moved out of `records/`. */
  archivedThrough: number
}

interface ArchiveJournalRecord {
  name: string
  sequence: number
  recordId: string
  bytes: number
  sha256: string
}

interface ArchiveJournal {
  schemaVersion: 1
  operation: 'archive'
  transactionId: string
  createdAt: string
  target: string
  throughSequence: number
  archivedThroughBefore: number
  records: ArchiveJournalRecord[]
  /** Optional only for journals created before Recorder content artifacts existed. */
  contents?: ToolContentRef[]
}

const ARCHIVE_STATE = 'archive-state.json'
const ARCHIVE_JOURNAL = 'archive-journal.json'

export async function readArchiveState(dataRoot: string): Promise<ArchiveState | null> {
  const path = join(dataRoot, ARCHIVE_STATE)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`invalid archive state: ${path}`)
  }
  const state = raw as Partial<ArchiveState> | null
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.archivedThrough) || Number(state.archivedThrough) < 0) {
    throw new Error(`invalid archive state: ${path}`)
  }
  return { schemaVersion: 1, archivedThrough: Number(state.archivedThrough) }
}

function pathContains(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

export function archivePathsOverlap(liveRecords: string, recordsTarget: string): boolean {
  return pathContains(liveRecords, recordsTarget) || pathContains(recordsTarget, liveRecords)
}

function validArchiveJournal(value: unknown): value is ArchiveJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1 || raw.operation !== 'archive' || typeof raw.transactionId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.transactionId)) return false
  if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt)) || typeof raw.target !== 'string' || !isAbsolute(raw.target)) return false
  if (!Number.isSafeInteger(raw.throughSequence) || !Number.isSafeInteger(raw.archivedThroughBefore) || !Array.isArray(raw.records)) return false
  if (raw.contents !== undefined && (!Array.isArray(raw.contents) || !raw.contents.every(isToolContentRef) || new Set(raw.contents.map((item) => item.sha256)).size !== raw.contents.length)) return false
  let previous = Number(raw.archivedThroughBefore)
  for (const item of raw.records) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const record = item as Record<string, unknown>
    const parsed = typeof record.name === 'string' ? parseRecordName(record.name) : null
    if (!parsed || parsed.sequence !== record.sequence || parsed.recordId !== record.recordId || parsed.sequence !== previous + 1) return false
    if (!Number.isSafeInteger(record.bytes) || Number(record.bytes) < 0 || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) return false
    previous = parsed.sequence
  }
  return raw.records.length > 0 && Number(raw.throughSequence) >= previous
}

export async function archiveJournal(dataRoot: string): Promise<ArchiveJournal | null> {
  const path = join(dataRoot, ARCHIVE_JOURNAL)
  let journal: unknown
  try {
    journal = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`invalid archive journal: ${path}`)
  }
  if (!validArchiveJournal(journal)) throw new Error(`invalid archive journal: ${path}`)
  return journal
}

async function verifiedArchiveContent(path: string, expected: ArchiveJournalRecord): Promise<Buffer> {
  const content = await readFile(path)
  const digest = createHash('sha256').update(content).digest('hex')
  if (content.byteLength !== expected.bytes || digest !== expected.sha256) {
    throw new Error(`archive record does not match journal: ${path}`)
  }
  return content
}

export interface ArchiveOptions {
  throughSequence: number
  target: string
  /** Deterministic crash seam used only by recorder durability tests. */
  onStep?: (phase: 'target-published' | 'copied' | 'source-removed', sequence: number) => Promise<void> | void
  /** Deterministic fsync fault seam used only by durability tests. */
  syncDirectory?: (path: string) => Promise<void>
}

/**
 * Move a contiguous prefix through a durable journal. A retry with the same target resumes any
 * verified copy/remove/floor step; a pending journal blocks sequence allocation until reconciled.
 */
export async function archiveRecords(
  dataRoot: string,
  options: ArchiveOptions
): Promise<{ archived: ArchiveJournalRecord[]; archivedThrough: number; target: string }> {
  return withDirectoryLock(join(dataRoot, 'locks', 'commit.lock'), async () => {
    const liveRecords = join(dataRoot, 'records')
    const recordsTarget = join(options.target, 'records')
    const sync = options.syncDirectory ?? syncDirectory
    if (archivePathsOverlap(resolve(liveRecords), resolve(recordsTarget))) {
      throw new Error('archive target must not overlap the live records directory')
    }
    await mkdirDurable(recordsTarget)
    if ((await lstat(recordsTarget)).isSymbolicLink()) throw new Error('archive records target must not be a symbolic link')
    const [canonicalLive, canonicalRecordsTarget, canonicalTarget] = await Promise.all([
      realpath(liveRecords), realpath(recordsTarget), realpath(options.target)
    ])
    if (archivePathsOverlap(canonicalLive, canonicalRecordsTarget)) {
      throw new Error('archive target must not overlap the live records directory')
    }

    let journal = await archiveJournal(dataRoot)
    if (journal) {
      if (journal.target !== canonicalTarget) throw new Error(`pending archive must be resumed with target ${journal.target}`)
    } else {
      const state = await readArchiveState(dataRoot)
      const floor = state?.archivedThrough ?? 0
      const liveFiles = await recordFiles(dataRoot, { bypassIndex: true })
      let expectedSequence = floor + 1
      for (const file of liveFiles) {
        if (file.sequence !== expectedSequence) throw new Error(`cannot archive a store with a sequence gap before ${file.name}`)
        expectedSequence += 1
      }
      const files = liveFiles.filter((file) => file.sequence <= options.throughSequence)
      if (files.length === 0) return { archived: [], archivedThrough: floor, target: options.target }
      if (
        (await listFiles(canonicalRecordsTarget)).length > 0 ||
        await existingFile(join(canonicalTarget, 'manifest.json')) ||
        await existingPath(join(canonicalTarget, 'content'))
      ) {
        throw Object.assign(new Error('archive target must be empty'), { code: 'EEXIST' })
      }
      const records: ArchiveJournalRecord[] = []
      const sourceRecords: AgentTurnRecord[] = []
      for (const file of files) {
        const source = join(canonicalLive, file.name)
        sourceRecords.push(await readRecordFile(source))
        const content = await readFile(source)
        records.push({
          ...file,
          bytes: content.byteLength,
          sha256: createHash('sha256').update(content).digest('hex')
        })
      }
      const contents = collectContentRefs(sourceRecords)
      // Fail before publishing a journal when a referenced source was already missing/corrupt.
      for (const ref of contents) await readRecorderContent(dataRoot, ref)
      journal = {
        schemaVersion: 1,
        operation: 'archive',
        transactionId: randomUUID(),
        createdAt: new Date().toISOString(),
        target: canonicalTarget,
        throughSequence: options.throughSequence,
        archivedThroughBefore: floor,
        records,
        contents
      }
      await writeJsonAtomic(join(dataRoot, ARCHIVE_JOURNAL), journal)
    }

    if (!journal.contents) {
      // Upgrade an interrupted pre-content journal from whichever verified record copy survived.
      const sourceRecords: AgentTurnRecord[] = []
      for (const record of journal.records) {
        const livePath = join(canonicalLive, record.name)
        const targetPath = join(canonicalRecordsTarget, record.name)
        sourceRecords.push(await readRecordFile(await existingFile(livePath) ? livePath : targetPath))
      }
      journal = { ...journal, contents: collectContentRefs(sourceRecords) }
      await writeJsonAtomic(join(dataRoot, ARCHIVE_JOURNAL), journal)
    }
    const contents = journal.contents ?? []
    const contentTarget = join(canonicalTarget, 'content')
    if (await existingPath(contentTarget) && (await lstat(contentTarget)).isSymbolicLink()) {
      throw new Error('archive content target must not be a symbolic link')
    }
    for (const ref of contents) await copyRecorderContent(dataRoot, canonicalTarget, ref)

    const expectedNames = new Set(journal.records.flatMap((record) => [
      record.name,
      basename(exclusiveWriteTempPath(join(canonicalRecordsTarget, record.name), journal.transactionId))
    ]))
    for (const name of await listFiles(canonicalRecordsTarget)) {
      if (!expectedNames.has(name)) throw new Error(`archive target contains a file outside the pending journal: ${name}`)
    }

    let archivedThrough = (await readArchiveState(dataRoot))?.archivedThrough ?? 0
    if (archivedThrough < journal.archivedThroughBefore || archivedThrough > journal.records.at(-1)!.sequence) {
      throw new Error('archive floor is inconsistent with pending journal')
    }
    for (const record of journal.records) {
      const source = join(canonicalLive, record.name)
      const target = join(canonicalRecordsTarget, record.name)
      const temporary = exclusiveWriteTempPath(target, journal.transactionId)
      const sourceExists = await existingFile(source)
      let targetExists = await existingFile(target)
      const temporaryExists = await existingFile(temporary)
      // A pending journal owns both copies, but neither may be silently discarded if its content
      // differs from the bytes hashed before the archive began.
      const sourceContent = sourceExists ? await verifiedArchiveContent(source, record) : undefined
      if (targetExists) await verifiedArchiveContent(target, record)
      if (temporaryExists) await verifiedArchiveContent(temporary, record)
      if (!targetExists) {
        if (temporaryExists) {
          await link(temporary, target)
          await sync(canonicalRecordsTarget)
          targetExists = true
          await options.onStep?.('target-published', record.sequence)
        } else {
          if (!sourceContent) throw new Error(`archive source and target are both missing: ${record.name}`)
          await writeFileAtomicExclusive(target, sourceContent, {
            temporaryId: journal.transactionId,
            onPublished: () => options.onStep?.('target-published', record.sequence),
            syncDirectory: sync
          })
          targetExists = true
        }
      }
      if (temporaryExists && targetExists) {
        await rm(temporary)
        await sync(canonicalRecordsTarget)
      }
      // This barrier is deliberately unconditional: an existing target may come from a prior
      // attempt whose link publication succeeded but directory fsync failed.
      await sync(canonicalRecordsTarget)
      await options.onStep?.('copied', record.sequence)
      if (sourceExists) {
        await rm(source)
        await sync(canonicalLive)
      }
      await options.onStep?.('source-removed', record.sequence)
      if (archivedThrough < record.sequence) {
        archivedThrough = record.sequence
        await writeJsonAtomic(join(dataRoot, ARCHIVE_STATE), { schemaVersion: 1, archivedThrough } satisfies ArchiveState)
      }
    }

    await writeJsonAtomic(join(canonicalTarget, 'manifest.json'), {
      schemaVersion: 1,
      transactionId: journal.transactionId,
      at: new Date().toISOString(),
      recorderVersion: RECORDER_VERSION,
      from: journal.records[0].sequence,
      to: archivedThrough,
      count: journal.records.length,
      records: journal.records,
      contents
    })
    await rm(join(dataRoot, ARCHIVE_JOURNAL))
    await sync(dataRoot)
    invalidateRecordIndex(dataRoot)
    return { archived: journal.records, archivedThrough, target: options.target }
  })
}
