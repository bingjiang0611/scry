import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TraceEvent } from '../shared/trace'
import type { ProviderId } from '../shared/provider'
import {
  TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES,
  TRACE_ARCHIVE_PAGE_INDEX_MAX_ENTRIES,
  TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
  TRACE_ARCHIVE_TURN_FILE,
  type TraceArchive,
  type TraceArchiveDirectoryStamp,
  type TraceArchiveIndex,
  type TraceArchiveIndexEntry,
  type TraceArchiveTurn,
  traceArchiveIndexPath,
  traceArchiveMetadataDir,
  traceArchiveMetadataPath,
  traceArchiveTurnDir,
  traceArchiveTurnKey,
  writeOwnedFileAtomically,
  writeOwnedFileAtomicallyAsync
} from './transcript-archive-paths'

type TraceArchiveIndexCacheEntry = {
  key: string
  value: TraceArchiveIndex
}

const traceArchiveIndexCache = new Map<string, TraceArchiveIndexCacheEntry>()
const TRACE_ARCHIVE_INDEX_CACHE_LIMIT = 2

function traceArchiveIndexCacheKey(path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

export function getCachedTraceArchiveIndex(path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): TraceArchiveIndex | null {
  const key = traceArchiveIndexCacheKey(path, stat)
  const cached = traceArchiveIndexCache.get(path)
  return cached?.key === key ? cached.value : null
}

export function cacheTraceArchiveIndex(path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, value: TraceArchiveIndex): TraceArchiveIndex {
  traceArchiveIndexCache.set(path, { key: traceArchiveIndexCacheKey(path, stat), value })
  while (traceArchiveIndexCache.size > TRACE_ARCHIVE_INDEX_CACHE_LIMIT) {
    traceArchiveIndexCache.delete(traceArchiveIndexCache.keys().next().value!)
  }
  return value
}

export function isTraceArchiveIndex(value: unknown, args: {
  cwd: string
  sessionId: string
  providerId: ProviderId
}): value is TraceArchiveIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const index = value as Partial<TraceArchiveIndex>
  if ((index.version !== 1 && index.version !== 2) || index.cwd !== args.cwd || index.sessionId !== args.sessionId || index.providerId !== args.providerId ||
      (index.version === 2 && index.profileMetadataVersion !== TRACE_ARCHIVE_PROFILE_METADATA_VERSION) ||
      !index.directory || typeof index.directory.mtimeMs !== 'number' || !Number.isFinite(index.directory.mtimeMs) ||
      typeof index.directory.ctimeMs !== 'number' || !Number.isFinite(index.directory.ctimeMs) ||
      typeof index.directory.ino !== 'number' || !Number.isFinite(index.directory.ino) || !Array.isArray(index.entries) ||
      index.entries.length > TRACE_ARCHIVE_PAGE_INDEX_MAX_ENTRIES) return false
  const files = new Set<string>()
  return index.entries.every((entry) => {
    if (!entry || typeof entry !== 'object' || !TRACE_ARCHIVE_TURN_FILE.test(entry.file) ||
        typeof entry.runId !== 'string' || !entry.runId || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts) ||
        (index.version === 2 && entry.profileMetadataVersion !== TRACE_ARCHIVE_PROFILE_METADATA_VERSION) ||
        files.has(entry.file) || (entry.agentProfileId !== undefined && entry.agentProfileId !== null &&
          (typeof entry.agentProfileId !== 'string' || !entry.agentProfileId))) return false
    files.add(entry.file)
    if (index.version === 2) {
      const metadata = entry.metadata
      if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size <= 0 ||
          typeof entry.mtimeMs !== 'number' || !Number.isFinite(entry.mtimeMs) ||
          typeof entry.ctimeMs !== 'number' || !Number.isFinite(entry.ctimeMs) ||
          typeof entry.ino !== 'number' || !Number.isSafeInteger(entry.ino) || entry.ino <= 0 ||
          !metadata || typeof metadata.userText !== 'string' || typeof metadata.done !== 'boolean' ||
          typeof metadata.hasSuccessfulResult !== 'boolean' || !Array.isArray(metadata.toolIds) || !Array.isArray(metadata.acceptedSteers) ||
          !metadata.toolIds.every((item) => item && typeof item.stage === 'string' && typeof item.toolUseId === 'string') ||
          !metadata.acceptedSteers.every((item) => item && typeof item.messageId === 'string' && typeof item.prompt === 'string')) return false
    }
    return true
  })
}

export function archiveTurnMetadata(turn: TraceArchiveTurn): TraceArchiveIndexEntry['metadata'] {
  return {
    providerTurnId: turn.providerTurnId,
    forkTurnId: turn.forkTurnId,
    userText: turn.userText,
    done: turn.done,
    status: turn.status,
    error: turn.error,
    errorHint: turn.errorHint,
    hasSuccessfulResult: turn.items.some((event) => event.stage === 'result' && event.isError === false),
    toolIds: turn.items.filter((event): event is TraceEvent & { toolUseId: string } => !!event.toolUseId)
      .map((event) => ({ stage: event.stage, toolUseId: event.toolUseId })),
    acceptedSteers: turn.items
      .filter((event) => event.stage === 'steer' && event.steer?.status === 'accepted' && !!event.steer.messageId)
      .map((event) => ({ messageId: event.steer!.messageId, prompt: event.steer!.prompt }))
  }
}

export function archiveMetadataTurn(entry: TraceArchiveIndexEntry): TraceArchiveTurn | null {
  const metadata = entry.metadata
  if (!metadata) return null
  return {
    runId: entry.runId,
    ...(entry.agentProfileId !== undefined ? { agentProfileId: entry.agentProfileId } : {}),
    providerTurnId: metadata.providerTurnId,
    forkTurnId: metadata.forkTurnId,
    userText: metadata.userText,
    done: metadata.done,
    status: metadata.status,
    error: metadata.error,
    errorHint: metadata.errorHint,
    items: [
      ...(metadata.hasSuccessfulResult ? [{
        id: `archive-index-result-${entry.runId}`,
        runId: entry.runId,
        ts: String(entry.ts),
        kind: 'harness' as const,
        stage: 'result' as const,
        isError: false
      }] : []),
      ...metadata.toolIds.map((item, index): TraceEvent => ({
        id: `archive-index-${entry.runId}-${index}`,
        runId: entry.runId,
        ts: String(entry.ts),
        kind: 'tool',
        stage: item.stage,
        toolUseId: item.toolUseId,
        runtimeMetadata: { source: 'scry_archive_index' }
      })),
      ...metadata.acceptedSteers.map((steer, index): TraceEvent => ({
        id: `archive-index-steer-${entry.runId}-${index}`,
        runId: entry.runId,
        ts: String(entry.ts),
        kind: 'human',
        stage: 'steer',
        steer: { messageId: steer.messageId, prompt: steer.prompt, attachments: [], status: 'accepted' }
      }))
    ],
    ts: entry.ts
  }
}

export function archiveDirectoryStamp(info: { mtimeMs: number; ctimeMs: number; ino: number }): TraceArchiveDirectoryStamp {
  return { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino }
}

export function sameArchiveDirectoryStamp(left: TraceArchiveDirectoryStamp, right: TraceArchiveDirectoryStamp): boolean {
  return left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino
}

export function sameArchiveSegmentStamp(entry: TraceArchiveIndexEntry, stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): boolean {
  return entry.size === stat.size && entry.mtimeMs === stat.mtimeMs && entry.ctimeMs === stat.ctimeMs && entry.ino === stat.ino
}

export async function archiveIndexFromArchives(
  args: { userDataDir: string; cwd: string; sessionId: string; providerId: ProviderId },
  directory: TraceArchiveDirectoryStamp,
  archives: TraceArchive[],
  signal?: AbortSignal
): Promise<TraceArchiveIndex> {
  const turns = archives.flatMap((archive) => archive.turns).sort((left, right) => left.ts - right.ts || traceArchiveTurnKey(left).localeCompare(traceArchiveTurnKey(right)))
  const entries: TraceArchiveIndexEntry[] = []
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  for (let offset = 0; offset < turns.length; offset += 32) {
    signal?.throwIfAborted()
    const batch = await Promise.all(turns.slice(offset, offset + 32).map(async (turn) => {
      const file = `${traceArchiveTurnKey(turn)}.json`
      const stat = await lstat(join(dir, file))
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('trace archive segment is not a trusted regular file')
      return {
        file,
        profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
        ...(turn.agentProfileId !== undefined ? { agentProfileId: turn.agentProfileId } : {}),
        runId: turn.runId,
        ts: turn.ts,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        ino: stat.ino,
        metadata: archiveTurnMetadata(turn)
      }
    }))
    entries.push(...batch)
  }
  return {
    version: 2,
    profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
    cwd: args.cwd,
    sessionId: args.sessionId,
    providerId: args.providerId,
    directory,
    entries
  }
}

export async function writeTraceArchiveIndex(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}, index: TraceArchiveIndex): Promise<void> {
  if (index.entries.length > TRACE_ARCHIVE_PAGE_INDEX_MAX_ENTRIES) throw new Error('trace archive page index capacity exceeded')
  const content = `${JSON.stringify(index)}\n`
  if (Buffer.byteLength(content) > TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES) throw new Error('trace archive page index capacity exceeded')
  await writeOwnedFileAtomicallyAsync(
    args.userDataDir,
    traceArchiveIndexPath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    content
  )
}

export function writeTraceArchiveMetadataSidecar(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}, entry: TraceArchiveIndexEntry): void {
  const dir = traceArchiveMetadataDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  writeOwnedFileAtomically(args.userDataDir, traceArchiveMetadataPath(dir, entry.file), `${JSON.stringify(entry)}\n`)
}

export async function writeTraceArchiveMetadataSidecarAsync(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}, entry: TraceArchiveIndexEntry): Promise<void> {
  const dir = traceArchiveMetadataDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  await writeOwnedFileAtomicallyAsync(args.userDataDir, traceArchiveMetadataPath(dir, entry.file), `${JSON.stringify(entry)}\n`)
}
