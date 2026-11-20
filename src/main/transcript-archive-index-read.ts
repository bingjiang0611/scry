import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../shared/provider'
import {
  TRACE_ARCHIVE_METADATA_FILE,
  TRACE_ARCHIVE_METADATA_SUFFIX,
  TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES,
  TRACE_ARCHIVE_PAGE_INDEX_MAX_ENTRIES,
  TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
  TRACE_ARCHIVE_TURN_FILE,
  type TraceArchiveDirectoryStamp,
  type TraceArchiveIndex,
  type TraceArchiveIndexEntry,
  traceArchiveIndexPath,
  traceArchiveMetadataDir,
  traceArchiveMetadataPath,
  traceArchiveTurnDir,
  traceArchiveTurnPath,
  trustedOwnedParent
} from './transcript-archive-paths'
import { inspectArchiveFileAsync, inspectSegmentedArchivesAsync } from './transcript-archive-validate'
import {
  archiveDirectoryStamp,
  archiveIndexFromArchives,
  archiveTurnMetadata,
  cacheTraceArchiveIndex,
  getCachedTraceArchiveIndex,
  isTraceArchiveIndex,
  sameArchiveDirectoryStamp,
  sameArchiveSegmentStamp,
  writeTraceArchiveIndex
} from './transcript-archive-index'

export async function readSegmentedMetadataIndexAsync(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}, signal?: AbortSignal): Promise<TraceArchiveIndex | null> {
  signal?.throwIfAborted()
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  try {
    trustedOwnedParent(args.userDataDir, join(dir, '.identity'), false)
    const directoryStat = await lstat(dir)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null
    const directory = archiveDirectoryStamp(directoryStat)
    const allNames = await readdir(dir)
    const names = allNames.filter((name) => TRACE_ARCHIVE_TURN_FILE.test(name)).sort()
    const metadataDir = traceArchiveMetadataDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
    trustedOwnedParent(args.userDataDir, join(metadataDir, '.identity'), false)
    const metadataNames = (await readdir(metadataDir)).filter((name) => TRACE_ARCHIVE_METADATA_FILE.test(name)).sort()
    const metadataFiles = new Set(metadataNames)
    const metadataCoverageComplete = metadataFiles.size === names.length && names.every((name) => metadataFiles.has(name.replace(/\.json$/, TRACE_ARCHIVE_METADATA_SUFFIX)))
    // metadata sidecars are disposable; canonical files remain authoritative
    const entries: TraceArchiveIndexEntry[] = []
    for (const file of names) {
      signal?.throwIfAborted()
      const segmentPath = join(dir, file)
      const metadataPath = traceArchiveMetadataPath(metadataDir, file)
      const [segmentStat, metadataStat] = await Promise.all([lstat(segmentPath), lstat(metadataPath)])
      if (!segmentStat.isFile() || segmentStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.isSymbolicLink() ||
          metadataStat.size <= 0 || metadataStat.size > TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES) return null
      const value = JSON.parse(await readFile(metadataPath, { encoding: 'utf8', signal })) as TraceArchiveIndexEntry
      if (!value || value.file !== file || !isTraceArchiveIndex({
        version: 2,
        profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
        cwd: args.cwd,
        sessionId: args.sessionId,
        providerId: args.providerId,
        directory,
        entries: [value]
      }, args) || !sameArchiveSegmentStamp(value, segmentStat)) return null
      entries.push(value)
    }
    const after = archiveDirectoryStamp(await lstat(dir))
    if (!sameArchiveDirectoryStamp(directory, after)) return null
    const index: TraceArchiveIndex = { version: 2, profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION, cwd: args.cwd, sessionId: args.sessionId, providerId: args.providerId, directory,
      sourceComplete: metadataCoverageComplete,
      sourceIssue: metadataCoverageComplete ? undefined : 'canonical archive segment coverage changed',
      entries: entries.sort((left, right) => left.ts - right.ts || left.file.localeCompare(right.file)) }
    // A live session can have only per-turn deltas before its first history read. Publish
    // the validated base once so later pages do not reopen every metadata sidecar.
    if (metadataCoverageComplete) await writeTraceArchiveIndex(args, index)
    return index
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (signal?.aborted) throw signal.reason
    return null
  }
}

async function readTraceArchiveMetadataSidecarAsync(
  args: { userDataDir: string; cwd: string; sessionId: string; providerId: ProviderId },
  directory: TraceArchiveDirectoryStamp,
  file: string,
  stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number },
  signal?: AbortSignal
): Promise<TraceArchiveIndexEntry | null> {
  const metadataPath = traceArchiveMetadataPath(traceArchiveMetadataDir(args.userDataDir, args.cwd, args.sessionId, args.providerId), file)
  try {
    trustedOwnedParent(args.userDataDir, metadataPath, false)
    const metadataStat = await lstat(metadataPath)
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size <= 0 || metadataStat.size > TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES) return null
    const value: unknown = JSON.parse(await readFile(metadataPath, { encoding: 'utf8', signal }))
    if (!value || (value as TraceArchiveIndexEntry).file !== file || !isTraceArchiveIndex({
      version: 2,
      profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
      cwd: args.cwd,
      sessionId: args.sessionId,
      providerId: args.providerId,
      directory,
      entries: [value as TraceArchiveIndexEntry]
    }, args) || !sameArchiveSegmentStamp(value as TraceArchiveIndexEntry, stat)) return null
    return value as TraceArchiveIndexEntry
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return null
  }
}

export async function readValidTraceArchiveIndex(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}, signal?: AbortSignal): Promise<TraceArchiveIndex | null> {
  signal?.throwIfAborted()
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  try {
    trustedOwnedParent(args.userDataDir, join(dir, '.identity'), false)
    const path = traceArchiveIndexPath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
    const [indexStat, directoryStat] = await Promise.all([lstat(path), lstat(dir)])
    if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size <= 0 ||
        indexStat.size > TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null
    const cached = getCachedTraceArchiveIndex(path, indexStat)
    const parsed = cached ?? JSON.parse(await readFile(path, { encoding: 'utf8', signal })) as unknown
    if (!isTraceArchiveIndex(parsed, args)) return null
    const value = cached ?? cacheTraceArchiveIndex(path, indexStat, parsed)
    if (value.version !== 2) {
      return sameArchiveDirectoryStamp(value.directory, archiveDirectoryStamp(directoryStat)) ? value : null
    }
    // A degraded base index is not evidence that missing canonical turns are absent. Force the
    // authoritative rebuild path so repaired source can restore complete coverage.
    if (value.sourceComplete === false) return null

    const directory = archiveDirectoryStamp(directoryStat)
    const canonicalNames = (await readdir(dir)).filter((name) => TRACE_ARCHIVE_TURN_FILE.test(name)).sort()
    const stats = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; ino: number }>()
    for (let offset = 0; offset < canonicalNames.length; offset += 32) {
      signal?.throwIfAborted()
      const batch = await Promise.all(canonicalNames.slice(offset, offset + 32).map(async (file) => {
        const stat = await lstat(join(dir, file))
        return { file, stat }
      }))
      for (const { file, stat } of batch) {
        if (!stat.isFile() || stat.isSymbolicLink()) return null
        stats.set(file, stat)
      }
    }
    const baseByFile = new Map(value.entries.map((entry) => [entry.file, entry]))
    const membershipUnchanged = canonicalNames.length === baseByFile.size && canonicalNames.every((file) => baseByFile.has(file))
    const removedCount = value.entries.filter((entry) => !stats.has(entry.file)).length
    const fingerprintsUnchanged = membershipUnchanged && canonicalNames.every((file) => sameArchiveSegmentStamp(baseByFile.get(file)!, stats.get(file)!))
    if (sameArchiveDirectoryStamp(value.directory, directory) && fingerprintsUnchanged) return value

    const entries: TraceArchiveIndexEntry[] = []
    let invalidCount = removedCount
    for (const file of canonicalNames) {
      signal?.throwIfAborted()
      const stat = stats.get(file)!
      const base = baseByFile.get(file)
      if (base && sameArchiveSegmentStamp(base, stat)) {
        entries.push(base)
        continue
      }
      const sidecar = await readTraceArchiveMetadataSidecarAsync(args, directory, file, stat, signal)
      if (sidecar) {
        entries.push(sidecar)
        continue
      }
      const inspected = await inspectArchiveFileAsync(args.userDataDir, join(dir, file), args.cwd, args.sessionId, args.providerId, signal)
      if (inspected.status !== 'valid' || inspected.archive.turns.length !== 1 ||
          traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, inspected.archive.turns[0]) !== join(dir, file)) {
        invalidCount++
        continue
      }
      const turn = inspected.archive.turns[0]
      const finalStat = await lstat(join(dir, file))
      if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.size !== stat.size ||
          finalStat.mtimeMs !== stat.mtimeMs || finalStat.ctimeMs !== stat.ctimeMs || finalStat.ino !== stat.ino) {
        invalidCount++
        continue
      }
      entries.push({ file, profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION, ...(turn.agentProfileId !== undefined ? { agentProfileId: turn.agentProfileId } : {}), runId: turn.runId, ts: turn.ts, size: finalStat.size, mtimeMs: finalStat.mtimeMs, ctimeMs: finalStat.ctimeMs, ino: finalStat.ino, metadata: archiveTurnMetadata(turn) })
    }
    return {
      version: 2,
      profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
      cwd: args.cwd,
      sessionId: args.sessionId,
      providerId: args.providerId,
      directory,
      sourceComplete: invalidCount === 0,
      sourceIssue: invalidCount ? `${invalidCount} canonical archive segment(s) unavailable` : value.sourceIssue,
      entries: entries.sort((left, right) => left.ts - right.ts || left.file.localeCompare(right.file))
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return null
  }
}

export async function traceArchiveIndexVersionAsync(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}): Promise<1 | 2 | null> {
  try {
    const path = traceArchiveIndexPath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES) return null
    const value = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown; entries?: unknown }
    if (!Array.isArray(value.entries) || value.entries.length > TRACE_ARCHIVE_PAGE_INDEX_MAX_ENTRIES) return null
    return value.version === 1 || value.version === 2 ? value.version : null
  } catch { return null }
}

export async function upgradeTraceArchiveIndexAsync(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}, index: TraceArchiveIndex | null, signal?: AbortSignal): Promise<TraceArchiveIndex | null> {
  if (!index || index.version !== 1) return index
  const inspected = await inspectSegmentedArchivesAsync(args, signal)
  if (inspected.invalid.length > 0) return null
  try {
    const directory = archiveDirectoryStamp(await lstat(traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)))
    const upgraded = await archiveIndexFromArchives(args, directory, inspected.valid, signal)
    await writeTraceArchiveIndex(args, upgraded)
    return upgraded
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return null
  }
}
