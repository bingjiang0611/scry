import { closeSync, constants, lstatSync, openSync, readSync } from 'node:fs'
import { copyFile, lstat, open as openFile, rename, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { workspaceToolContentPolicy } from '../core/turn-recorder/content-policy.js'
import {
  archivedTranscriptPath,
  transcriptPath,
  trustedOwnedFile,
  trustedOwnedParent
} from './transcript-archive-paths'

async function mirrorPrefixMatches(source: string, target: string, size: number): Promise<boolean> {
  if (size === 0) return true
  const sourceFile = await openFile(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  const targetFile = await openFile(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const starts = [...new Set([0, Math.max(0, size - 4096)])]
    for (const start of starts) {
      const length = Math.min(4096, size - start)
      const sourceBytes = Buffer.allocUnsafe(length)
      const targetBytes = Buffer.allocUnsafe(length)
      const [sourceRead, targetRead] = await Promise.all([
        sourceFile.read(sourceBytes, 0, length, start),
        targetFile.read(targetBytes, 0, length, start)
      ])
      if (sourceRead.bytesRead !== length || targetRead.bytesRead !== length || !sourceBytes.equals(targetBytes)) return false
    }
    return true
  } finally {
    await Promise.allSettled([sourceFile.close(), targetFile.close()])
  }
}

type TranscriptMirrorProvenance = { sourceDev: number; sourceIno: number; sourceSize: number; sourceMtimeMs: number }
const transcriptMirrorProvenance = new Map<string, TranscriptMirrorProvenance>()
const rememberTranscriptMirrorProvenance = (filePath: string, value: TranscriptMirrorProvenance): void => {
  transcriptMirrorProvenance.delete(filePath)
  transcriptMirrorProvenance.set(filePath, value)
  if (transcriptMirrorProvenance.size > 128) {
    const oldest = transcriptMirrorProvenance.keys().next().value
    if (oldest !== undefined) transcriptMirrorProvenance.delete(oldest)
  }
}

async function copyToOwnedFileAtomically(userDataDir: string, source: string, filePath: string): Promise<void> {
  trustedOwnedParent(userDataDir, filePath, true)
  const sourceStat = await lstat(source)
  if (trustedOwnedFile(userDataDir, filePath)) {
    try {
      const targetStat = await lstat(filePath)
      const provenance = transcriptMirrorProvenance.get(filePath)
      const canAppend = provenance?.sourceDev === sourceStat.dev && provenance.sourceIno === sourceStat.ino &&
        provenance.sourceSize === targetStat.size && targetStat.size <= sourceStat.size
      if (canAppend && await mirrorPrefixMatches(source, filePath, targetStat.size)) {
        if (targetStat.size === sourceStat.size && provenance.sourceMtimeMs === sourceStat.mtimeMs) return
        const input = await openFile(source, constants.O_RDONLY | constants.O_NOFOLLOW)
        let output: Awaited<ReturnType<typeof openFile>> | undefined
        try {
          output = await openFile(filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
          const openedTarget = await output.stat()
          if (openedTarget.dev !== targetStat.dev || openedTarget.ino !== targetStat.ino) throw new Error('transcript mirror target changed during append')
          const buffer = Buffer.allocUnsafe(64 * 1024)
          let position = targetStat.size
          while (position < sourceStat.size) {
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, sourceStat.size - position), position)
            if (bytesRead === 0) break
            let written = 0
            while (written < bytesRead) {
              const result = await output.write(buffer, written, bytesRead - written)
              written += result.bytesWritten
            }
            position += bytesRead
          }
          await output.sync()
          rememberTranscriptMirrorProvenance(filePath, {
            sourceDev: sourceStat.dev,
            sourceIno: sourceStat.ino,
            sourceSize: sourceStat.size,
            sourceMtimeMs: sourceStat.mtimeMs
          })
          return
        } finally {
          await Promise.allSettled([input.close(), ...(output ? [output.close()] : [])])
        }
      }
    } catch {
    }
  }

  const tmp = `${filePath}.tmp`
  try {
    try {
      await unlink(tmp)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await copyFile(source, tmp, constants.COPYFILE_EXCL)
    await rename(tmp, filePath)
    rememberTranscriptMirrorProvenance(filePath, {
      sourceDev: sourceStat.dev,
      sourceIno: sourceStat.ino,
      sourceSize: sourceStat.size,
      sourceMtimeMs: sourceStat.mtimeMs
    })
  } catch (error) {
    try { await unlink(tmp) } catch {}
    throw error
  }
}

export function resolveNativeTranscriptPath(args: {
  cwd: string
  sessionId: string
  home?: string
}): string | null {
  const primary = transcriptPath(args.cwd, args.sessionId, args.home)
  return inspectTranscriptIdentity(primary, args.cwd, args.sessionId).status === 'match' ? primary : null
}

export function resolveTranscriptPath(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  home?: string
}): string | null {
  const primary = resolveNativeTranscriptPath(args)
  if (primary) return primary
  const archived = archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
  if (trustedOwnedFile(args.userDataDir, archived)) return archived
  return null
}

const transcriptMirrorTasks = new Map<string, Promise<boolean>>()

export function mirrorTranscript(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  home?: string
}): Promise<boolean> {
  const source = transcriptPath(args.cwd, args.sessionId, args.home)
  const dest = archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
  const previous = transcriptMirrorTasks.get(dest) ?? Promise.resolve(true)
  const task = previous.then(async () => {
    try { workspaceToolContentPolicy(args.cwd) } catch { return false }
    if (inspectTranscriptIdentity(source, args.cwd, args.sessionId).status !== 'match') return false
    try {
      await copyToOwnedFileAtomically(args.userDataDir, source, dest)
      return true
    } catch {
      return false
    }
  })
  transcriptMirrorTasks.set(dest, task)
  void task.finally(() => {
    if (transcriptMirrorTasks.get(dest) === task) transcriptMirrorTasks.delete(dest)
  })
  return task
}

type TranscriptIdentityInspection = { status: 'match' | 'foreign' } | { status: 'invalid'; error: string }
interface TranscriptIdentityCache {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  cwd: string
  sessionId: string
  endedWithNewline: boolean
  prefixHash: string
  cwds: Set<string>
  sessions: Set<string>
}
const transcriptIdentityCache = new Map<string, TranscriptIdentityCache>()

function transcriptIdentityResult(
  state: Pick<TranscriptIdentityCache, 'cwds' | 'sessions' | 'cwd' | 'sessionId'>
): TranscriptIdentityInspection {
  if (state.cwds.size !== 1 || state.sessions.size !== 1) {
    return { status: 'invalid', error: 'transcript has missing or conflicting identity' }
  }
  return state.cwds.has(state.cwd) && state.sessions.has(state.sessionId) ? { status: 'match' } : { status: 'foreign' }
}

function readUtf8Range(filePath: string, start: number, end: number): string {
  const buffer = Buffer.alloc(Math.max(0, end - start))
  const fd = openSync(filePath, 'r')
  let offset = 0
  try {
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, start + offset)
      if (read === 0) break
      offset += read
    }
  } finally {
    closeSync(fd)
  }
  return buffer.toString('utf8', 0, offset)
}

function transcriptPrefixHash(filePath: string, size: number): string {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.allocUnsafe(Math.min(4096, size))
    const bytesRead = buffer.length ? readSync(fd, buffer, 0, buffer.length, 0) : 0
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')
  } finally {
    closeSync(fd)
  }
}

function inspectTranscriptIdentity(
  filePath: string,
  cwd: string,
  sessionId: string
): TranscriptIdentityInspection {
  try {
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'invalid', error: 'transcript is not a trusted regular file' }
    const prefixHash = transcriptPrefixHash(filePath, stat.size)
    const cached = transcriptIdentityCache.get(filePath)
    if (
      cached && cached.dev === stat.dev && cached.ino === stat.ino && cached.cwd === cwd && cached.sessionId === sessionId &&
      cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.prefixHash === prefixHash
    ) return transcriptIdentityResult(cached)

    const append = cached && cached.dev === stat.dev && cached.ino === stat.ino && cached.cwd === cwd &&
      cached.sessionId === sessionId && cached.endedWithNewline && cached.prefixHash === prefixHash &&
      stat.mtimeMs >= cached.mtimeMs && stat.size > cached.size
    const start = append ? cached.size : 0
    const cwds = append ? new Set(cached.cwds) : new Set<string>()
    const sessions = append ? new Set(cached.sessions) : new Set<string>()
    const content = readUtf8Range(filePath, start, stat.size)
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line) as Record<string, unknown>
      if (typeof row.cwd === 'string') cwds.add(row.cwd)
      if (typeof row.sessionId === 'string') sessions.add(row.sessionId)
    }
    const state: TranscriptIdentityCache = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      cwd,
      sessionId,
      endedWithNewline: content.endsWith('\n'),
      prefixHash,
      cwds,
      sessions
    }
    transcriptIdentityCache.delete(filePath)
    transcriptIdentityCache.set(filePath, state)
    if (transcriptIdentityCache.size > 128) transcriptIdentityCache.delete(transcriptIdentityCache.keys().next().value!)
    return transcriptIdentityResult(state)
  } catch (error) {
    transcriptIdentityCache.delete(filePath)
    return { status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

export function clearTranscriptMirrorCaches(filePath: string): void {
  transcriptMirrorProvenance.delete(filePath)
  transcriptIdentityCache.delete(filePath)
}
