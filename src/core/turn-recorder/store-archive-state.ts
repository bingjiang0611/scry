import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isToolContentRef, type ToolContentRef } from '../../shared/tool-content.js'
import { parseRecordName } from './store-shared.js'

export interface ArchiveState {
  schemaVersion: 1
  /** Highest sequence intentionally moved out of `records/`. */
  archivedThrough: number
}

export interface ArchiveJournalRecord {
  name: string
  sequence: number
  recordId: string
  bytes: number
  sha256: string
}

export interface ArchiveJournal {
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

export const ARCHIVE_STATE = 'archive-state.json'
export const ARCHIVE_JOURNAL = 'archive-journal.json'

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

export function pathContains(root: string, candidate: string): boolean {
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

export async function existingFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function existingPath(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
