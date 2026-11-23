import { constants } from 'node:fs'
import { lstat, open as openFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ProviderId } from '../shared/provider'
import {
  TRACE_ARCHIVE_INDEX_SUFFIX,
  type TraceArchive,
  type TraceArchiveTurn,
  type TraceArchiveVersion,
  traceArchivePath,
  traceArchiveTurnDir,
  traceArchiveTurnPath,
  trustedOwnedParent
} from './transcript-archive-paths'
import {
  archiveCandidates,
  inspectArchiveFileAsync,
  inspectSegmentedArchivesAsync,
  mergeArchives,
  validateArchive
} from './transcript-archive-validate'
import { archiveMetadataTurn, writeTraceArchiveIndex } from './transcript-archive-index'
import {
  readSegmentedMetadataIndexAsync,
  readValidTraceArchiveIndex,
  traceArchiveIndexVersionAsync,
  upgradeTraceArchiveIndexAsync
} from './transcript-archive-index-read'

export function readTraceArchive(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}): TraceArchive | null {
  return mergeArchives(archiveCandidates(args))
}

export async function readTraceArchiveMetadataAsync(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}, signal?: AbortSignal): Promise<TraceArchive | null> {
  const monolith = await inspectArchiveFileAsync(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId,
    signal
  )
  if (monolith.status === 'valid') return null
  const validIndex = await readValidTraceArchiveIndex(args, signal)
  const storedVersion = validIndex?.version ?? await traceArchiveIndexVersionAsync(args)
  const indexed = validIndex ?? await readSegmentedMetadataIndexAsync(args, signal)
  const index = await upgradeTraceArchiveIndexAsync(args, indexed, signal)
  if (index?.version === 2 && storedVersion === 1 && (!validIndex || validIndex.version === 1)) await writeTraceArchiveIndex(args, index)
  if (!index || index.version !== 2) return null
  signal?.throwIfAborted()
  return {
    version: 3,
    cwd: args.cwd,
    sessionId: args.sessionId,
    externalSessionId: args.sessionId,
    providerId: args.providerId,
    turns: index.entries.map((entry) => archiveMetadataTurn(entry)).filter((turn): turn is TraceArchiveTurn => turn != null)
  }
}

export async function readTraceArchiveTurnsAsync(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}, runIds: readonly string[], signal?: AbortSignal): Promise<TraceArchiveTurn[]> {
  signal?.throwIfAborted()
  if (runIds.length === 0) return []
  const monolith = await inspectArchiveFileAsync(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId,
    signal
  )
  if (monolith.status === 'valid') {
    const merged = await readTraceArchiveAsync(args, signal)
    return (merged?.turns ?? []).filter((turn) => runIds.includes(turn.runId))
  }
  const indexed = await readValidTraceArchiveIndex(args, signal) ?? await readSegmentedMetadataIndexAsync(args, signal)
  const index = await upgradeTraceArchiveIndexAsync(args, indexed, signal)
  if (!index || index.version !== 2) {
    const archive = await readTraceArchiveAsync(args, signal)
    return (archive?.turns ?? []).filter((turn) => runIds.includes(turn.runId))
  }
  const wanted = new Set(runIds)
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  const turns: TraceArchiveTurn[] = []
  for (const entry of index.entries) {
    if (!wanted.has(entry.runId)) continue
    const inspected = await inspectArchiveFileAsync(args.userDataDir, join(dir, entry.file), args.cwd, args.sessionId, args.providerId, signal)
    if (inspected.status !== 'valid' || inspected.archive.turns.length !== 1 || inspected.archive.turns[0].runId !== entry.runId) {
      throw new Error('trace archive index entry changed or is corrupt')
    }
    turns.push(inspected.archive.turns[0])
  }
  return turns
}

export async function readTraceArchiveAsync(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}, signal?: AbortSignal, requireComplete = false): Promise<TraceArchive | null> {
  signal?.throwIfAborted()
  const current = await inspectArchiveFileAsync(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId,
    signal
  )
  const segmented = await inspectSegmentedArchivesAsync(args, signal)
  if (requireComplete && (current.status === 'invalid' || segmented.invalid.length)) {
    throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
  }
  return mergeArchives((current.status === 'valid' ? [current.archive] : []).concat(segmented.valid))
}

export async function readTraceArchiveForMigration(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}): Promise<TraceArchive | null> {
  const mono = traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  const directory = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  let names: string[] = []
  try {
    trustedOwnedParent(args.userDataDir, join(directory, '.identity'), false)
    names = (await readdir(directory)).filter(name => /^turn-[a-f0-9]{64}\.json$/.test(name))
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (names.length > 2000) throw new Error('迁移超过 2000 轮读取预算')
  let bytes = 0
  for (const path of [mono, ...names.map(name => join(directory, name))]) {
    try {
      trustedOwnedParent(args.userDataDir, path, false)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('迁移源不是受控普通文件')
      bytes += info.size
      if (bytes > 16 * 1024 * 1024) throw new Error('迁移归档超过 16 MiB 读取预算')
    } catch (error) {
      if (path !== mono || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const current = await inspectArchiveFileAsync(args.userDataDir, mono, args.cwd, args.sessionId, args.providerId)
  const segmented = await inspectSegmentedArchivesAsync(args)
  if (current.status === 'invalid' || segmented.invalid.length) throw new Error('迁移源归档损坏或身份不匹配；旧入口保留')
  const archive = mergeArchives((current.status === 'valid' ? [current.archive] : []).concat(segmented.valid))
  if (archive && archive.turns.length > 2000) throw new Error('迁移超过 2000 轮读取预算')
  return archive
}

export async function readTraceArchiveVersionAsync(
  args: { cwd: string; sessionId: string; userDataDir: string; providerId: ProviderId; agentProfileId?: string | null }
): Promise<TraceArchiveVersion> {
  const paths = [
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    `${traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)}${TRACE_ARCHIVE_INDEX_SUFFIX}`
  ]
  const stats: string[] = []
  for (const path of paths) {
    try {
      const value = await lstat(path)
      stats.push(`${path}:${value.isDirectory() ? 'd' : 'f'}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`)
    } catch { stats.push(`${path}:missing`) }
  }
  const hasMonolithic = stats[0]?.endsWith(':missing') === false
  const hasIndex = stats[2]?.endsWith(':missing') === false
  return {
    version: createHash('sha256').update(JSON.stringify([stats.slice(0, 2), Object.hasOwn(args, 'agentProfileId') ? [args.agentProfileId] : []])).digest('hex'),
    readMode: hasMonolithic ? 'monolithic' : hasIndex ? 'indexed' : 'index_rebuild'
  }
}

export function traceArchiveRunIds(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}): string[] {
  const ids = new Set<string>()
  for (const archive of archiveCandidates(args)) {
    for (const turn of archive.turns) if (turn.runId) ids.add(turn.runId)
  }
  return [...ids]
}

export async function readTraceArchiveTurnForHistory(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
  runId: string
  providerTurnId?: string
  maxBytes: number
}): Promise<{ turn: TraceArchiveTurn; bytesRead: number }> {
  const paths = [
    traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, args),
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  ]
  for (const path of paths) {
    let handle: Awaited<ReturnType<typeof openFile>>
    try {
      trustedOwnedParent(args.userDataDir, path, false)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('交接源归档不是受控普通文件')
      handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > args.maxBytes) throw new Error('交接源归档超出读取预算或不是普通文件')
      const buffer = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length !== info.size) throw new Error('读取交接源归档时文件发生变化')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
      const inspected = validateArchive(JSON.parse(text), args.cwd, args.sessionId, args.providerId)
      if (inspected.status !== 'valid') throw new Error('交接源归档损坏或身份不匹配')
      const turns = inspected.archive.turns.filter((turn) => turn.runId === args.runId)
      if (turns.length !== 1 || (args.providerTurnId && turns[0].providerTurnId !== args.providerTurnId)) {
        throw new Error('交接源归档缺少唯一匹配的原生轮次')
      }
      return { turn: turns[0], bytesRead: length }
    } finally {
      await handle.close()
    }
  }
  throw new Error('交接源归档不存在')
}

export async function findTraceArchiveTurnMatches(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
  runId: string
  providerTurnId?: string
}): Promise<{ byRunId?: TraceArchiveTurn; byProviderTurnId?: TraceArchiveTurn }> {
  const exactPath = traceArchiveTurnPath(
    args.userDataDir,
    args.cwd,
    args.sessionId,
    args.providerId,
    { runId: args.runId, providerTurnId: args.providerTurnId }
  )
  const [legacy, exact] = await Promise.all([
    inspectArchiveFileAsync(args.userDataDir, traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId), args.cwd, args.sessionId, args.providerId),
    inspectArchiveFileAsync(args.userDataDir, exactPath, args.cwd, args.sessionId, args.providerId)
  ])
  const archives: TraceArchive[] = []
  if (legacy.status === 'valid') archives.push(legacy.archive)
  if (exact.status === 'valid' && exact.archive.turns.length === 1) archives.push(exact.archive)
  const turns = mergeArchives(archives)?.turns ?? []
  return {
    byRunId: turns.find((turn) => turn.runId === args.runId),
    byProviderTurnId: args.providerTurnId
      ? turns.find((turn) => turn.providerTurnId === args.providerTurnId)
      : undefined
  }
}
