import { constants } from 'node:fs'
import { lstat, open, readdir, readFile, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { ProviderId } from '../shared/provider'
import {
  readTraceArchiveMetadataAsync, traceArchivePath, traceArchiveTurnPath, type TraceArchiveTurn
} from './transcript-archive'
import {
  iterateArchiveEntries, type ArchiveReadEvidence, type ArchiveTurnExpectation
} from './trace-archive-projection'

export type { ArchiveEntry } from './trace-archive-projection'

export interface TraceArchiveCaptureArgs {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
  /** Proven source profile; when the archive carries profile provenance it must match. */
  agentProfileId?: string
}

export interface TraceArchiveCaptureInfo {
  /**
   * `indexed`: the persisted per-turn index supplied the order.
   * `stream_rebuild`: no usable index; turn metadata is recovered by a projected read.
   * `monolithic`: legacy single-file archive, streamed turn by turn.
   */
  readMode: 'indexed' | 'stream_rebuild' | 'monolithic'
  /** Null for a legacy monolithic file, whose turn count is only known after streaming. */
  totalTurns: number | null
}

export class TraceArchiveCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraceArchiveCaptureError'
  }
}

const TURN_FILE = /^turn-[a-f0-9]{64}\.json$/
/** Turn bodies per re-read batch; bounds one batch's live handles, not the history. */
const BATCH_TURNS = 20

interface SegmentMeta {
  file: string
  runId: string
  providerTurnId?: string
  ts: number
  agentProfileId?: string | null
}

async function canonicalRoot(userDataDir: string): Promise<string> {
  return realpath(resolve(userDataDir))
}

/**
 * Open one archive file after proving it lives inside the controlled userData tree.
 *
 * This mirrors `trustedOwnedParent` in transcript-archive.ts, which is private and
 * lives in a file too large to extend safely: canonical-directory containment plus
 * O_NOFOLLOW, never a path assembled from renderer input.
 */
async function openOwnedFile(root: string, path: string): Promise<{ handle: FileHandle; size: number; identity: string }> {
  const directory = await realpath(dirname(path))
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) {
    throw new TraceArchiveCaptureError('来源归档路径不属于受控存储')
  }
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) {
    throw new TraceArchiveCaptureError('来源归档文件不是受控普通文件')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const opened = await handle.stat()
  if (!opened.isFile() || opened.size !== info.size || opened.ino !== info.ino || opened.dev !== info.dev) {
    await handle.close()
    throw new TraceArchiveCaptureError('来源归档文件在打开时发生变化')
  }
  return { handle, size: opened.size, identity: stamp(opened) }
}

/** Stamps include mtime/ctime so a same-size rewrite during the read is visible. */
function stamp(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}

async function assertUnchanged(handle: FileHandle, identity: string): Promise<void> {
  const after = await handle.stat()
  if (stamp(after) !== identity) {
    throw new TraceArchiveCaptureError('来源归档文件在读取期间被改写，不能确认真实来源')
  }
}

function indexFilePath(args: TraceArchiveCaptureArgs): string {
  return `${dirname(traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, { runId: 'probe' }))}.index-v1.json`
}

/**
 * Persisted index version only. A v1 index can only be upgraded by parsing every
 * turn body, so a v1 archive takes the projected rebuild path instead.
 */
async function storedIndexVersion(args: TraceArchiveCaptureArgs): Promise<1 | 2 | null> {
  try {
    const info = await lstat(indexFilePath(args))
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 32 * 1024 * 1024) return null
    const value = JSON.parse(await readFile(indexFilePath(args), 'utf8')) as { version?: unknown }
    return value.version === 1 || value.version === 2 ? value.version : null
  } catch { return null }
}

async function segmentNames(args: TraceArchiveCaptureArgs): Promise<string[]> {
  const directory = dirname(traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, { runId: 'probe' }))
  try {
    return (await readdir(directory)).filter(name => TURN_FILE.test(name)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Inventory the source archive without parsing a single turn body.
 *
 * A live session may have a valid persisted index, only per-turn metadata sidecars,
 * or neither. This reports which of those is true; it never falls back to reading a
 * body just to answer "how many turns are there".
 */
export async function traceArchiveCaptureInfo(args: TraceArchiveCaptureArgs): Promise<TraceArchiveCaptureInfo> {
  const mono = traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  const monoExists = await lstat(mono).then(info => info.isFile() && !info.isSymbolicLink(), () => false)
  if (monoExists) return { readMode: 'monolithic', totalTurns: null }
  const names = await segmentNames(args)
  if (names.length === 0) return { readMode: 'indexed', totalTurns: 0 }
  if (await storedIndexVersion(args) === 1) return { readMode: 'stream_rebuild', totalTurns: names.length }
  const metadata = await readTraceArchiveMetadataAsync(args)
  if (metadata && metadata.turns.length === names.length) return { readMode: 'indexed', totalTurns: names.length }
  return { readMode: 'stream_rebuild', totalTurns: names.length }
}

function assertProfile(expected: string | undefined, actual: string | null | undefined): void {
  // A pre-profile archive carries no provenance; the catalog identity check still applies.
  if (actual === undefined) return
  if ((actual ?? undefined) !== expected) {
    throw new TraceArchiveCaptureError('来源归档属于其它 Agent Profile，不能作为侧聊来源')
  }
}

function expectationFor(args: TraceArchiveCaptureArgs, meta: SegmentMeta | undefined): ArchiveTurnExpectation {
  return {
    cwd: args.cwd, sessionId: args.sessionId, providerId: args.providerId,
    turnCount: 'single',
    ...(meta?.runId !== undefined ? { runId: meta.runId } : {}),
    ...(meta?.providerTurnId !== undefined ? { providerTurnId: meta.providerTurnId } : {})
  }
}

/**
 * Every source turn in canonical order, with bounded memory.
 *
 * Turn bodies are read by a structural projection: a 195 MiB tool payload is never
 * materialized and never becomes a string. Only the visible text and steer evidence
 * of each turn are kept, one turn at a time.
 */
export async function* iterateTraceArchiveCapture(
  args: TraceArchiveCaptureArgs,
  info: TraceArchiveCaptureInfo
): AsyncGenerator<import('./trace-archive-projection').ArchiveEntry> {
  if (info.totalTurns === 0) return
  const root = await canonicalRoot(args.userDataDir)
  if (info.readMode === 'monolithic') {
    const path = traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
    const opened = await openOwnedFile(root, path)
    try {
      const evidence: ArchiveReadEvidence = { bytesRead: 0, digest: '' }
      for await (const turn of iterateArchiveEntries(opened.handle, opened.size, {
        cwd: args.cwd, sessionId: args.sessionId, providerId: args.providerId, turnCount: 'many'
      }, evidence)) yield turn
      await assertUnchanged(opened.handle, opened.identity)
    } finally {
      await opened.handle.close()
    }
    return
  }
  const metadata = info.readMode === 'indexed' ? await readTraceArchiveMetadataAsync(args) : null
  const segments = metadata && metadata.turns.length === info.totalTurns
    ? metadata.turns.map(turn => segmentOf(turn))
    : await rebuildIndex(root, args)
  for (let offset = 0; offset < segments.length; offset += BATCH_TURNS) {
    for (const segment of segments.slice(offset, offset + BATCH_TURNS)) {
      assertProfile(args.agentProfileId, segment.agentProfileId)
      const path = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, segment)
      const opened = await openOwnedFile(root, path)
      try {
        const evidence: ArchiveReadEvidence = { bytesRead: 0, digest: '' }
        for await (const turn of iterateArchiveEntries(
          opened.handle, opened.size, expectationFor(args, segment), evidence
        )) {
          if (turn.type === 'turn' && turn.runId !== segment.runId) {
            throw new TraceArchiveCaptureError('来源归档分片与索引不一致')
          }
          yield turn
        }
        await assertUnchanged(opened.handle, opened.identity)
      } finally {
        await opened.handle.close()
      }
    }
  }
}

/**
 * One turn of a split archive, read as a projected stream.
 *
 * The conversation-capture path needs a single turn's visible text; reading its file as a
 * stream means a large turn costs one bounded projection pass instead of a whole-file
 * buffer and a fixed byte ceiling. Identity is re-asserted after the pass.
 */
export async function* streamTraceArchiveTurn(
  args: TraceArchiveCaptureArgs,
  turn: { runId: string; providerTurnId?: string }
): AsyncGenerator<import('./trace-archive-projection').ArchiveEntry> {
  const root = await canonicalRoot(args.userDataDir)
  const path = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, turn)
  const opened = await openOwnedFile(root, path)
  try {
    const evidence: ArchiveReadEvidence = { bytesRead: 0, digest: '' }
    // The caller on this path (a recorded conversation turn) already holds the binding
    // profile and the turn's item hashes, so the body is proven against those instead of
    // against a session-level sidecar this single-file read never opens.
    for await (const entry of iterateArchiveEntries(opened.handle, opened.size, expectationFor(args, {
      file: '', runId: turn.runId, ts: 0,
      ...(turn.providerTurnId === undefined ? {} : { providerTurnId: turn.providerTurnId })
    }), evidence)) yield entry
    await assertUnchanged(opened.handle, opened.identity)
  } finally {
    await opened.handle.close()
  }
}

function segmentOf(turn: TraceArchiveTurn): SegmentMeta {
  return {
    file: '', runId: turn.runId, ts: turn.ts,
    ...(turn.providerTurnId !== undefined ? { providerTurnId: turn.providerTurnId } : {}),
    ...(turn.agentProfileId !== undefined ? { agentProfileId: turn.agentProfileId } : {})
  }
}

/**
 * Recover turn order when the index/sidecars are missing or stale.
 *
 * Passing over the bodies is unavoidable here, but each pass is a projected stream:
 * memory stays bounded by one turn's visible text, and a legacy 195 MiB payload is
 * skipped by structure. The second pass must see the same digest, so a rewrite
 * between passes is refused rather than frozen into a snapshot.
 */
async function rebuildIndex(root: string, args: TraceArchiveCaptureArgs): Promise<SegmentMeta[]> {
  const names = await segmentNames(args)
  const found: Array<SegmentMeta & { digest: string }> = []
  for (const file of names) {
    const path = dirname(traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, { runId: 'probe' }))
    const opened = await openOwnedFile(root, `${path}/${file}`)
    try {
      const evidence: ArchiveReadEvidence = { bytesRead: 0, digest: '' }
      let meta: SegmentMeta | undefined
      for await (const turn of iterateArchiveEntries(opened.handle, opened.size, {
        cwd: args.cwd, sessionId: args.sessionId, providerId: args.providerId, turnCount: 'single'
      }, evidence, { metadataOnly: true })) {
        if (turn.type !== 'turn') continue
        meta = {
          file: '', runId: turn.runId, ts: turn.ts,
          ...(turn.providerTurnId !== undefined ? { providerTurnId: turn.providerTurnId } : {})
        }
      }
      await assertUnchanged(opened.handle, opened.identity)
      if (!meta) throw new TraceArchiveCaptureError('来源归档分片缺少轮次')
      found.push({ ...meta, file, digest: evidence.digest })
    } finally {
      await opened.handle.close()
    }
  }
  found.sort((left, right) => left.ts - right.ts || left.file.localeCompare(right.file))
  return found.map(({ digest: _digest, ...meta }) => meta)
}
