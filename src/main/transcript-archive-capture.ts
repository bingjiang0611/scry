import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { ProviderId } from '../shared/provider'
import {
  readTraceArchiveAsync, readTraceArchiveMetadataAsync, readTraceArchivePageAsync, traceArchiveTurnPath
} from './transcript-archive'
import { readArchiveTurnProjection, type ArchiveTurnProjection } from './trace-archive-projection'

export type { ArchiveTurnProjection } from './trace-archive-projection'

export interface TraceArchiveCaptureArgs {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}

export interface TraceArchiveCaptureInfo {
  /** Legacy monolithic archives are one whole-file parse; segmented archives page. */
  readMode: 'monolithic' | 'indexed' | 'index_rebuild'
  /** False means at least one canonical segment is unavailable; capture must refuse. */
  sourceComplete: boolean
  totalTurns: number
  sourceIssue?: string
}

export class TraceArchiveCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraceArchiveCaptureError'
  }
}

/**
 * Open one canonical turn segment for a streaming read.
 *
 * This mirrors `trustedOwnedParent` in transcript-archive.ts, which is private and
 * lives in a file too large to extend safely; the check is canonical-directory
 * containment plus O_NOFOLLOW, never a path assembled from renderer input.
 */
async function openSegment(userDataDir: string, path: string): Promise<{ handle: Awaited<ReturnType<typeof open>>; size: number; identity: string }> {
  const root = await realpath(resolve(userDataDir))
  const directory = await realpath(dirname(path))
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) {
    throw new TraceArchiveCaptureError('来源归档路径不属于受控存储')
  }
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) {
    throw new TraceArchiveCaptureError('来源归档分片不是受控普通文件')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const opened = await handle.stat()
  if (!opened.isFile() || opened.size !== info.size || opened.ino !== info.ino || opened.dev !== info.dev) {
    await handle.close()
    throw new TraceArchiveCaptureError('来源归档分片在打开时发生变化')
  }
  return { handle, size: opened.size, identity: `${opened.dev}:${opened.ino}:${opened.size}` }
}

/** Bodies per batch. This bounds one batch's memory, not the session's history. */
const CAPTURE_BATCH_TURNS = 20

/**
 * Cheap inventory of a source archive, read before any turn body.
 *
 * A capture must never describe a session it could not read completely, so an
 * incomplete source is refused here instead of silently freezing a shorter prefix.
 */
export async function traceArchiveCaptureInfo(args: TraceArchiveCaptureArgs): Promise<TraceArchiveCaptureInfo> {
  const page = await readTraceArchivePageAsync(args, { limit: 1 })
  const info: TraceArchiveCaptureInfo = {
    readMode: page.readMode,
    sourceComplete: page.sourceComplete,
    totalTurns: page.totalTurns,
    ...(page.sourceIssue ? { sourceIssue: page.sourceIssue } : {})
  }
  if (!page.sourceComplete) {
    throw new TraceArchiveCaptureError(`来源归档有不可用的轮次分片，不能冻结不完整的快照：${page.sourceIssue ?? '未知分片'}`)
  }
  return info
}

/**
 * Every completed source turn in canonical order, with bounded memory.
 *
 * Segmented archives are read turn by turn through the persisted index: each turn
 * body is projected from a token stream so a 195 MiB turn never becomes a 195 MiB
 * string. Legacy monolithic archives still cost one whole-file parse; that cost is
 * reported by `readMode`, not hidden behind a byte ceiling.
 */
export async function* iterateTraceArchiveCapture(
  args: TraceArchiveCaptureArgs,
  info: TraceArchiveCaptureInfo
): AsyncGenerator<ArchiveTurnProjection> {
  if (info.totalTurns === 0) return
  const metadata = info.readMode === 'monolithic' ? null : await readTraceArchiveMetadataAsync(args)
  if (!metadata) {
    const archive = await readTraceArchiveAsync(args)
    for (const turn of archive?.turns ?? []) {
      yield { runId: turn.runId, ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
        ts: turn.ts, done: turn.done, ...(turn.status ? { status: turn.status } : {}),
        userText: turn.userText, events: turn.items }
    }
    return
  }
  const turns = metadata.turns
  if (turns.length !== info.totalTurns) {
    throw new TraceArchiveCaptureError('来源归档在冻结期间发生变化，请重新预览')
  }
  for (let offset = 0; offset < turns.length; offset += CAPTURE_BATCH_TURNS) {
    for (const turn of turns.slice(offset, offset + CAPTURE_BATCH_TURNS)) {
      const path = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, turn)
      const opened = await openSegment(args.userDataDir, path)
      try {
        const projection = await readArchiveTurnProjection(opened.handle, opened.size, {
          cwd: args.cwd, sessionId: args.sessionId, providerId: args.providerId,
          runId: turn.runId, ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {})
        })
        const after = await opened.handle.stat()
        if (`${after.dev}:${after.ino}:${after.size}` !== opened.identity) {
          throw new TraceArchiveCaptureError('来源归档分片在读取期间被替换，不能确认真实来源')
        }
        yield projection
      } finally {
        await opened.handle.close()
      }
    }
  }
}
