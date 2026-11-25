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
  agentProfileId?: string
}

export interface TraceArchiveCaptureInfo {
  readMode: 'indexed' | 'stream_rebuild' | 'monolithic'
  totalTurns: number | null
}

export class TraceArchiveCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraceArchiveCaptureError'
  }
}

const TURN_FILE = /^turn-[a-f0-9]{64}\.json$/
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

export async function* streamTraceArchiveTurn(
  args: TraceArchiveCaptureArgs,
  turn: { runId: string; providerTurnId?: string }
): AsyncGenerator<import('./trace-archive-projection').ArchiveEntry> {
  const root = await canonicalRoot(args.userDataDir)
  const path = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, turn)
  const opened = await openOwnedFile(root, path)
  try {
    const evidence: ArchiveReadEvidence = { bytesRead: 0, digest: '' }
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
