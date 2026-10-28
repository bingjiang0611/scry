import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, readFile, realpath, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { type AgentTurnRecord } from '../../shared/turn-record.js'
import { copyRecorderContent, readRecorderContent } from './content-store.js'
import { exclusiveWriteTempPath, listFiles, mkdirDurable, syncDirectory, withDirectoryLock, writeFileAtomicExclusive, writeJsonAtomic } from './io.js'
import { archiveJournal, archivePathsOverlap, existingFile, existingPath, readArchiveState, type ArchiveJournalRecord, type ArchiveState } from './store-archive-state.js'
import { collectContentRefs, verifiedArchiveContent } from './store-content.js'
import { recordFiles, readRecordFile, invalidateRecordIndex, RECORDER_VERSION } from './store-shared.js'

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
      await writeJsonAtomic(join(dataRoot, 'archive-journal.json'), journal)
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
      await writeJsonAtomic(join(dataRoot, 'archive-journal.json'), journal)
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
        await writeJsonAtomic(join(dataRoot, 'archive-state.json'), { schemaVersion: 1, archivedThrough } satisfies ArchiveState)
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
    await rm(join(dataRoot, 'archive-journal.json'))
    await sync(dataRoot)
    invalidateRecordIndex(dataRoot)
    return { archived: journal.records, archivedThrough, target: options.target }
  })
}
