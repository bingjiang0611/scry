import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../shared/provider'
import { hydrateNewestSessionSnapshots } from './trace-diff-content'
import {
  type TraceArchive,
  type TraceArchiveDirectoryStamp,
  type TraceArchivePage,
  type TraceArchivePageRequest,
  traceArchiveIndexPath,
  traceArchivePath,
  traceArchiveTurnDir,
  trustedOwnedFile
} from './transcript-archive-paths'
import {
  inspectArchiveFileAsync,
  inspectSegmentedArchivesAsync,
  mergeArchives
} from './transcript-archive-validate'
import {
  archiveDirectoryStamp,
  archiveIndexFromArchives,
  sameArchiveDirectoryStamp,
  writeTraceArchiveIndex
} from './transcript-archive-index'
import {
  readSegmentedMetadataIndexAsync,
  readValidTraceArchiveIndex,
  traceArchiveIndexVersionAsync
} from './transcript-archive-index-read'

function selectArchiveProfile<T extends { agentProfileId?: string | null }>(turns: T[], request: TraceArchivePageRequest): T[] {
  if (!Object.hasOwn(request, 'agentProfileId')) return turns
  if (request.agentProfileId === undefined || turns.some((turn) => turn.agentProfileId === undefined ||
      (turn.agentProfileId !== null && (typeof turn.agentProfileId !== 'string' || !turn.agentProfileId)))) {
    throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
  }
  return turns.filter((turn) => turn.agentProfileId === request.agentProfileId)
}

function profileArchive(archive: TraceArchive | null, request: TraceArchivePageRequest): TraceArchive | null {
  if (!archive) return null
  const turns = selectArchiveProfile(archive.turns, request)
  return Object.hasOwn(request, 'agentProfileId') && !turns.length ? null : { ...archive, turns }
}

function traceArchivePageBounds(availableTurns: number, request: TraceArchivePageRequest): {
  offset: number
  end: number
  totalTurns: number
} {
  const snapshot = request.snapshotTotalTurns
  const totalTurns = snapshot != null && Number.isFinite(snapshot)
    ? Math.min(availableTurns, Math.max(0, Math.floor(snapshot)))
    : availableTurns
  const limit = Math.min(200, Math.max(1, Math.floor(request.limit ?? 40)))
  const end = request.before == null ? totalTurns : Math.max(0, Math.min(Math.floor(request.before), totalTurns))
  return { offset: Math.max(0, end - limit), end, totalTurns }
}

export async function readTraceArchivePageAsync(
  args: { cwd: string; sessionId: string; userDataDir: string; providerId: ProviderId },
  request: TraceArchivePageRequest = {},
  signal?: AbortSignal
): Promise<TraceArchivePage> {
  const page = await readTraceArchivePageBodyAsync(args, request, signal)
  if (page.archive) await hydrateNewestSessionSnapshots(args.userDataDir, args.cwd, page.archive.turns)
  return page
}

async function readTraceArchivePageBodyAsync(
  args: { cwd: string; sessionId: string; userDataDir: string; providerId: ProviderId },
  request: TraceArchivePageRequest,
  signal?: AbortSignal
): Promise<TraceArchivePage> {
  signal?.throwIfAborted()
  const strictStorage = Object.hasOwn(request, 'agentProfileId') || request.requireComplete === true
  const current = await inspectArchiveFileAsync(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId,
    signal
  )
  if (current.status === 'invalid' && strictStorage) {
    throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
  }
  if (current.status === 'valid') {
    const segmented = await inspectSegmentedArchivesAsync(args, signal)
    if (strictStorage && segmented.invalid.length) {
      throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
    }
    const archive = profileArchive(mergeArchives([current.archive, ...segmented.valid]), request)
    const { offset, end, totalTurns } = traceArchivePageBounds(archive?.turns.length ?? 0, request)
    return {
      archive: archive ? { ...archive, turns: archive.turns.slice(offset, end) } : null,
      offset,
      totalTurns,
      hasOlder: offset > 0,
      turnFilesRead: totalTurns,
      readMode: 'monolithic',
      sourceComplete: segmented.invalid.length === 0,
      sourceIssue: segmented.invalid.length ? `${segmented.invalid.length} canonical archive segment(s) unavailable` : undefined
    }
  }

  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  let index = await readValidTraceArchiveIndex(args, signal)
  if (Object.hasOwn(request, 'agentProfileId') && index?.version === 1) index = null
  if (!index) {
    const indexFileExists = trustedOwnedFile(args.userDataDir, traceArchiveIndexPath(args.userDataDir, args.cwd, args.sessionId, args.providerId))
    const storedIndexVersion = await traceArchiveIndexVersionAsync(args)
    if (!indexFileExists || storedIndexVersion === 2) index = await readSegmentedMetadataIndexAsync(args, signal)
  }
  if (strictStorage && index?.version === 2 && index.sourceComplete === false) {
    throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
  }
  if (!index || index.version !== 2) {
    let before: TraceArchiveDirectoryStamp | null = null
    try { before = archiveDirectoryStamp(await lstat(dir)) } catch {}
    const inspected = await inspectSegmentedArchivesAsync(args, signal)
    signal?.throwIfAborted()
    try {
      const after = archiveDirectoryStamp(await lstat(dir))
      const rebuilt = await archiveIndexFromArchives(args, after, inspected.valid, signal)
      if (before && sameArchiveDirectoryStamp(before, after) && inspected.invalid.length === 0) {
        await writeTraceArchiveIndex(args, rebuilt)
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
    }
    if (strictStorage && inspected.invalid.length) throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
    const merged = mergeArchives(inspected.valid)
    const archive = profileArchive(merged, request)
    const { offset, end, totalTurns } = traceArchivePageBounds(archive?.turns.length ?? 0, request)
    return {
      archive: archive ? { ...archive, turns: archive.turns.slice(offset, end) } : null,
      offset,
      totalTurns,
      hasOlder: offset > 0,
      turnFilesRead: inspected.valid.length,
      readMode: 'index_rebuild',
      sourceComplete: inspected.invalid.length === 0,
      sourceIssue: inspected.invalid.length ? `${inspected.invalid.length} canonical archive segment(s) unavailable` : undefined
    }
  }

  const scopedEntries = selectArchiveProfile(index.entries, request)
  const { offset, end, totalTurns } = traceArchivePageBounds(scopedEntries.length, request)
  const selected = scopedEntries.slice(offset, end)
  const archives = await Promise.all(selected.map(async (entry) => {
    const segmentPath = join(dir, entry.file)
    let segmentStat
    try { segmentStat = await lstat(segmentPath) } catch { return null }
    if (entry.size == null || entry.mtimeMs == null || entry.ctimeMs == null || entry.ino == null ||
        segmentStat.size !== entry.size || segmentStat.mtimeMs !== entry.mtimeMs || segmentStat.ctimeMs !== entry.ctimeMs || segmentStat.ino !== entry.ino) return null
    const inspected = await inspectArchiveFileAsync(
      args.userDataDir, segmentPath, args.cwd, args.sessionId, args.providerId, signal
    )
    if (inspected.status !== 'valid' || inspected.archive.turns.length !== 1) return null
    const turn = inspected.archive.turns[0]
    return turn.runId === entry.runId && turn.ts === entry.ts &&
      (!Object.hasOwn(request, 'agentProfileId') || turn.agentProfileId === request.agentProfileId) ? inspected.archive : null
  }))
  if (archives.some((archive) => archive == null)) {
    const rebuilt = await inspectSegmentedArchivesAsync(args, signal)
    if (strictStorage && rebuilt.invalid.length) throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
    const merged = mergeArchives(rebuilt.valid)
    const archive = profileArchive(merged, request)
    const { offset: rebuiltOffset, end: rebuiltEnd, totalTurns: rebuiltTotal } = traceArchivePageBounds(
      archive?.turns.length ?? 0,
      request
    )
    return {
      archive: archive ? { ...archive, turns: archive.turns.slice(rebuiltOffset, rebuiltEnd) } : null,
      offset: rebuiltOffset,
      totalTurns: rebuiltTotal,
      hasOlder: rebuiltOffset > 0,
      turnFilesRead: rebuilt.valid.length,
      readMode: 'index_rebuild',
      sourceComplete: rebuilt.invalid.length === 0,
      sourceIssue: rebuilt.invalid.length ? `${rebuilt.invalid.length} canonical archive segment(s) unavailable` : undefined
    }
  }
  return {
    archive: mergeArchives(archives.filter((archive): archive is TraceArchive => archive != null)),
    offset,
    totalTurns,
    hasOlder: offset > 0,
    turnFilesRead: selected.length,
    readMode: 'indexed',
    sourceComplete: index.sourceComplete !== false,
    sourceIssue: index.sourceIssue
  }
}
