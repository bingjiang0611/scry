import { lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { protectToolContent } from '../core/turn-recorder/content-policy.js'
import { externalizeTraceDiffPatches } from './trace-diff-content'
import type { AgentInputAttachment, RuntimeProvider } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import { storeAttachmentReference, storeAttachmentReferenceAsync } from './attachment-store'
import {
  archivedTranscriptPath,
  TRACE_ARCHIVE_METADATA_FILE,
  TRACE_ARCHIVE_METADATA_TEMP_FILE,
  TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
  type TraceArchive,
  type TraceArchiveTurn,
  traceArchiveIndexPath,
  traceArchiveMetadataDir,
  traceArchivePath,
  traceArchiveTurnKey,
  traceArchiveTurnPath,
  trustedOwnedParent,
  trustedSegmentTempPaths,
  writeOwnedFileAtomically,
  writeOwnedFileAtomicallyAsync
} from './transcript-archive-paths'
import {
  inspectArchiveFile,
  inspectArchiveFileAsync,
  inspectSegmentedArchives
} from './transcript-archive-validate'
import {
  markTraceArchiveCatalogIndexDirty,
  markTraceArchiveCatalogIndexDirtyAsync
} from './transcript-archive-catalog'
import {
  archiveTurnMetadata,
  writeTraceArchiveMetadataSidecar,
  writeTraceArchiveMetadataSidecarAsync
} from './transcript-archive-index'
import { clearTranscriptMirrorCaches } from './transcript-archive-mirror'

export {
  archivedTranscriptPath,
  cleanupTraceArchiveTemps,
  DEFAULT_TRACE_DISCOVERY_BUDGET,
  encodeCwd,
  traceArchivePath,
  traceArchiveTurnPath,
  transcriptDir,
  transcriptPath,
  type TraceArchive,
  type TraceArchivePage,
  type TraceArchivePageRequest,
  type TraceArchiveSessionSummary,
  type TraceArchiveTurn,
  type TraceArchiveVersion,
  type TraceDiscoveryBudget
} from './transcript-archive-paths'
export {
  discoverTraceArchiveSessionsAsync,
  scanTraceArchiveCatalogIndexAsync
} from './transcript-archive-catalog'
export {
  findTraceArchiveTurnMatches,
  readTraceArchive,
  readTraceArchiveAsync,
  readTraceArchiveForMigration,
  readTraceArchiveMetadataAsync,
  readTraceArchiveTurnForHistory,
  readTraceArchiveTurnsAsync,
  readTraceArchiveVersionAsync,
  traceArchiveRunIds
} from './transcript-archive-read'
export { readTraceArchivePageAsync } from './transcript-archive-page'
export { mirrorTranscript, resolveTranscriptPath } from './transcript-archive-mirror'

type TraceArchiveUpsertInput = Parameters<typeof upsertTraceArchiveTurn>[0]

function prepareArchiveUpdate(
  args: TraceArchiveUpsertInput,
  providerId: ProviderId,
  turn: TraceArchiveTurn,
  existing: ReturnType<typeof inspectArchiveFile>,
  fp: string
): TraceArchive | boolean {
  if (existing.status === 'invalid') return false
  if (
    existing.status === 'valid' &&
    (existing.archive.turns.length !== 1 ||
      traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, providerId, existing.archive.turns[0]) !== fp)
  ) return false
  try {
    const policy = existing.status === 'valid' ? existing.archive.turns[0]?.toolContentPolicy : undefined
    turn = protectToolContent({ ...turn, ...(policy ? { toolContentPolicy: policy } : {}) }, args.cwd)
  } catch { return false }
  if (existing.status === 'valid' && existing.archive.turns.length === 1 &&
      JSON.stringify(existing.archive.turns[0]) === JSON.stringify(turn)) return true
  return {
    version: 3,
    cwd: args.cwd,
    sessionId: args.sessionId,
    externalSessionId: args.sessionId,
    providerId,
    runtimeProvider: args.runtimeProvider ?? (existing.status === 'valid' ? existing.archive.runtimeProvider : undefined),
    turns: [turn]
  }
}

export function upsertTraceArchiveTurn(args: {
  cwd: string
  sessionId: string
  providerId?: ProviderId
  runtimeProvider?: RuntimeProvider
  userDataDir: string
  turn: Omit<TraceArchiveTurn, 'ts'> & { ts?: number }
}): boolean {
  if (!args.sessionId) return false
  const providerId = args.providerId ?? 'claude'
  let turn: TraceArchiveTurn = {
    ...args.turn,
    attachments: args.turn.attachments?.map((attachment) =>
      'storage' in attachment
        ? attachment
        : storeAttachmentReference(args.userDataDir, args.turn.runId, attachment as AgentInputAttachment)
    ),
    items: args.turn.items,
    ts: args.turn.ts ?? Date.now()
  }
  const fp = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, providerId, turn)
  const existing = inspectArchiveFile(args.userDataDir, fp, args.cwd, args.sessionId, providerId)
  const archive = prepareArchiveUpdate(args, providerId, turn, existing, fp)
  if (typeof archive === 'boolean') return archive
  turn = archive.turns[0]
  const indexArgs = {
    userDataDir: args.userDataDir,
    cwd: args.cwd,
    sessionId: args.sessionId,
    providerId
  }
  try {
    markTraceArchiveCatalogIndexDirty(args.userDataDir)
    writeOwnedFileAtomically(args.userDataDir, fp, `${JSON.stringify(archive)}\n`)
    const stat = lstatSync(fp)
    writeTraceArchiveMetadataSidecar(indexArgs, {
      file: `${traceArchiveTurnKey(turn)}.json`,
      profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
      runId: turn.runId,
      ts: turn.ts,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
      ...(turn.agentProfileId !== undefined ? { agentProfileId: turn.agentProfileId } : {}),
      metadata: archiveTurnMetadata(turn)
    })
    return true
  } catch {
    return false
  }
}

export async function upsertTraceArchiveTurnAsync(args: {
  cwd: string
  sessionId: string
  providerId?: ProviderId
  runtimeProvider?: RuntimeProvider
  userDataDir: string
  turn: Omit<TraceArchiveTurn, 'ts'> & { ts?: number }
}): Promise<boolean> {
  if (!args.sessionId) return false
  const providerId = args.providerId ?? 'claude'
  const attachments = args.turn.attachments
    ? await Promise.all(args.turn.attachments.map((attachment) =>
        'storage' in attachment ? attachment : storeAttachmentReferenceAsync(args.userDataDir, args.turn.runId, attachment as AgentInputAttachment)))
    : undefined
  let turn: TraceArchiveTurn = {
    ...args.turn,
    attachments,
    items: args.turn.items,
    ts: args.turn.ts ?? Date.now()
  }
  turn = (await externalizeTraceDiffPatches(args.userDataDir, args.cwd, turn)).turn
  const fp = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, providerId, turn)
  const existing = await inspectArchiveFileAsync(args.userDataDir, fp, args.cwd, args.sessionId, providerId)
  const archive = prepareArchiveUpdate(args, providerId, turn, existing, fp)
  if (typeof archive === 'boolean') return archive
  turn = archive.turns[0]
  const indexArgs = { userDataDir: args.userDataDir, cwd: args.cwd, sessionId: args.sessionId, providerId }
  try {
    await markTraceArchiveCatalogIndexDirtyAsync(args.userDataDir)
    await writeOwnedFileAtomicallyAsync(args.userDataDir, fp, `${JSON.stringify(archive)}\n`)
    const stat = await lstat(fp)
    await writeTraceArchiveMetadataSidecarAsync(indexArgs, {
      file: `${traceArchiveTurnKey(turn)}.json`, profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION, runId: turn.runId, ts: turn.ts,
      size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino,
      ...(turn.agentProfileId !== undefined ? { agentProfileId: turn.agentProfileId } : {}),
      metadata: archiveTurnMetadata(turn)
    })
    return true
  } catch { return false }
}

type DeleteFailure = { path: string; error: string }

export function deleteTranscriptCopies(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  home?: string
  providerId?: ProviderId
}): { deleted: string[]; failed: Array<{ path: string; error: string }> } {
  const providerId = args.providerId ?? 'claude'
  const indexPath = traceArchiveIndexPath(args.userDataDir, args.cwd, args.sessionId, providerId)
  const exactTargets = [
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, providerId),
    `${traceArchivePath(args.userDataDir, args.cwd, args.sessionId, providerId)}.tmp`,
    indexPath,
    `${indexPath}.tmp`
  ]
  if (providerId === 'claude') {
    const archived = archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
    exactTargets.push(archived, `${archived}.tmp`)
  }
  const deleted: string[] = []
  const failed: DeleteFailure[] = []
  const segmented = inspectSegmentedArchives({
    cwd: args.cwd,
    sessionId: args.sessionId,
    userDataDir: args.userDataDir,
    providerId
  })
  const segmentTemps = trustedSegmentTempPaths({
    cwd: args.cwd,
    sessionId: args.sessionId,
    userDataDir: args.userDataDir,
    providerId
  })
  exactTargets.push(...segmentTemps.paths)
  if (segmentTemps.error) failed.push(segmentTemps.error)
  const metadataDir = traceArchiveMetadataDir(args.userDataDir, args.cwd, args.sessionId, providerId)
  try {
    trustedOwnedParent(args.userDataDir, join(metadataDir, '.identity'), false)
    for (const name of readdirSync(metadataDir)) {
      if (TRACE_ARCHIVE_METADATA_FILE.test(name) || TRACE_ARCHIVE_METADATA_TEMP_FILE.test(name)) {
        exactTargets.push(join(metadataDir, name))
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      failed.push({ path: metadataDir, error: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const invalid of segmented.invalid) {
    failed.push(invalid)
    if (/\/turn-[a-f0-9]{64}\.json$/.test(invalid.path)) exactTargets.push(invalid.path, `${invalid.path}.tmp`)
  }
  for (const archive of segmented.valid) {
    const turn = archive.turns[0]
    const path = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, providerId, turn)
    exactTargets.push(path, `${path}.tmp`)
  }
  markTraceArchiveCatalogIndexDirty(args.userDataDir)
  for (const fp of [...new Set(exactTargets)]) {
    try {
      trustedOwnedParent(args.userDataDir, fp, false)
      unlinkSync(fp)
      clearTranscriptMirrorCaches(fp)
      deleted.push(fp)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed.push({ path: fp, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return { deleted, failed }
}
