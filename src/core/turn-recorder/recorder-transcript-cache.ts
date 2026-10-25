import { createHash } from 'node:crypto'
import { open as openFile, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { parseTranscriptSnapshot } from './recorder-transcript-parse.js'
import { nestedRecord, stringAt, type TranscriptRead } from './recorder-contracts.js'
import { textContent } from './recorder-codex-calls.js'
import type { TranscriptSnapshotIdentity } from './recorder-transcript-io.js'

interface TranscriptSnapshotCacheEntry {
  key: string
  read: TranscriptRead
}

const TRANSCRIPT_SNAPSHOT_CACHE_LIMIT = 8
const transcriptSnapshotCache = new Map<string, TranscriptSnapshotCacheEntry>()
let transcriptSnapshotCacheHits = 0
let transcriptSnapshotCacheMisses = 0

/** Process-local diagnostics used by complexity tests and the informational recovery benchmark. */
export function transcriptSnapshotCacheStats(): { hits: number; misses: number; entries: number } {
  return { hits: transcriptSnapshotCacheHits, misses: transcriptSnapshotCacheMisses, entries: transcriptSnapshotCache.size }
}

export function resetTranscriptSnapshotCache(): void {
  transcriptSnapshotCache.clear()
  transcriptSnapshotCacheHits = 0
  transcriptSnapshotCacheMisses = 0
}

function transcriptSnapshotCacheKey(args: {
  path: string
  startOffset?: number
  stable: boolean
  runId: string
  provider: ProviderId
  promptHash?: string
  providerTurnId?: string
  identity: TranscriptSnapshotIdentity
}): string {
  return JSON.stringify([
    args.path, args.startOffset ?? 0, args.stable, args.runId, args.provider,
    args.promptHash ?? '', args.providerTurnId ?? '', args.identity.dev, args.identity.ino,
    args.identity.size, args.identity.mtimeMs, args.identity.ctimeMs
  ])
}



function archivedCodexTranscriptPath(path: string): string | undefined {
  const marker = `${sep}sessions${sep}`
  const index = path.lastIndexOf(marker)
  if (index < 0) return undefined
  return join(path.slice(0, index), 'archived_sessions', basename(path))
}

async function readableTranscriptPath(path: string, provider: ProviderId): Promise<string> {
  try {
    await stat(path)
    return path
  } catch {
    if (provider !== 'codex') return path
  }
  const archived = archivedCodexTranscriptPath(path)
  if (!archived) return path
  try {
    await stat(archived)
    return archived
  } catch {
    return path
  }
}

function transcriptLineAnchor(
  line: string,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string
): 'turn' | 'user' | undefined {
  let row: Record<string, unknown>
  try {
    row = JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (provider === 'codex') {
    const payload = nestedRecord(row, 'payload') ?? {}
    if (row.type === 'event_msg' && payload.type === 'task_started') {
      const id = stringAt(payload, 'turn_id', 'turnId')
      return providerTurnId ? id === providerTurnId ? 'turn' : undefined : !promptHash ? 'turn' : undefined
    }
    if (row.type !== 'event_msg' || payload.type !== 'user_message') return undefined
    const text = stringAt(payload, 'message', 'text', 'prompt') ?? textContent(payload.content) ?? ''
    const matchesHash = !!promptHash && [text, text.replace(/^\/[A-Za-z0-9_-]+\s*/, '')]
      .some((candidate) => createHash('sha256').update(candidate).digest('hex') === promptHash)
    return matchesHash || !promptHash && !providerTurnId ? 'user' : undefined
  }
  if (row.type !== 'user') return undefined
  const id = stringAt(row, 'promptId', 'prompt_id', 'turnId', 'turn_id')
  if (providerTurnId && id === providerTurnId) return 'turn'
  const text = textContent((row.message as Record<string, unknown> | undefined)?.content) ?? ''
  const command = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>[\s\S]*?<command-args>\s*([\s\S]*?)\s*<\/command-args>/i.exec(text)
  const candidates = [
    text,
    ...(command ? [`${command[1]}${command[2].trim() ? ` ${command[2].trim()}` : ''}`] : [])
  ]
  const matchesHash = !!promptHash && candidates
    .some((candidate) => createHash('sha256').update(candidate).digest('hex') === promptHash)
  return matchesHash || !promptHash && !providerTurnId ? 'turn' : undefined
}

async function transcriptAnchorOffset(
  path: string,
  endOffset: number,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string
): Promise<number> {
  if (endOffset <= 0 || !promptHash && !providerTurnId) return 0
  const handle = await openFile(path, 'r')
  const chunkBytes = 1024 * 1024
  let cursor = endOffset
  let suffix = Buffer.alloc(0)
  let matchedUserOffset: number | undefined
  let matchedTurnOffset: number | undefined
  try {
    while (cursor > 0) {
      const start = Math.max(0, cursor - chunkBytes)
      const chunk = Buffer.allocUnsafe(cursor - start)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start)
      if (bytesRead !== chunk.length) return 0
      const combined = Buffer.concat([chunk, suffix])
      let lineEnd = combined.length
      for (let index = combined.length - 1; index >= 0; index--) {
        if (combined[index] !== 0x0a) continue
        const lineStart = index + 1
        if (lineEnd > lineStart) {
          const absoluteOffset = start + lineStart
          const anchor = transcriptLineAnchor(combined.subarray(lineStart, lineEnd).toString('utf8'), provider, promptHash, providerTurnId)
          const windowOffset = Math.max(0, absoluteOffset - 1)
          if (provider !== 'codex') {
            if (anchor === 'turn') return windowOffset
          } else {
            const anyAnchor = transcriptLineAnchor(
              combined.subarray(lineStart, lineEnd).toString('utf8'), provider, undefined, undefined
            )
            if (matchedTurnOffset != null && anyAnchor === 'turn') return windowOffset
            if (anchor === 'turn' || matchedUserOffset != null && anyAnchor === 'turn') {
              matchedTurnOffset = windowOffset
            } else if (anchor === 'user' && matchedUserOffset == null) {
              matchedUserOffset = windowOffset
            }
          }
        }
        lineEnd = index
      }
      suffix = combined.subarray(0, lineEnd)
      // NUL cannot occur in a valid JSONL record. Sparse/uninitialized prefixes are
      // therefore a hard format boundary, not evidence that must be loaded to byte 0.
      if (matchedTurnOffset != null && suffix.includes(0)) return matchedTurnOffset
      cursor = start
    }
    if (suffix.length) {
      const firstLine = suffix.toString('utf8')
      const anchor = transcriptLineAnchor(firstLine, provider, promptHash, providerTurnId)
      if (anchor === 'turn') return 0
      if (provider === 'codex' && matchedTurnOffset != null && transcriptLineAnchor(firstLine, provider) === 'turn') return 0
      if (anchor === 'user' && matchedUserOffset == null) matchedUserOffset = 0
    }
    return matchedTurnOffset ?? matchedUserOffset ?? 0
  } finally {
    await handle.close()
  }
}

async function cachedTranscriptSnapshot(args: {
  path: string
  startOffset?: number
  stable: boolean
  runId: string
  provider: ProviderId
  promptHash?: string
  providerTurnId?: string
  identity: TranscriptSnapshotIdentity
}): Promise<TranscriptRead> {
  const key = transcriptSnapshotCacheKey(args)
  const cached = transcriptSnapshotCache.get(key)
  if (cached) {
    transcriptSnapshotCache.delete(key)
    transcriptSnapshotCache.set(key, cached)
    transcriptSnapshotCacheHits++
    return cached.read
  }
  transcriptSnapshotCacheMisses++
  const read = await parseTranscriptSnapshot({ ...args, endOffset: args.identity.size })
  // A read that raced truncation/rotation must be retried; caching it under the stable identity
  // would otherwise keep a recoverable turn pending for the lifetime of this process.
  if (!args.stable || read.stable) transcriptSnapshotCache.set(key, { key, read })
  while (transcriptSnapshotCache.size > TRANSCRIPT_SNAPSHOT_CACHE_LIMIT) {
    const oldest = transcriptSnapshotCache.keys().next().value
    if (typeof oldest !== 'string') break
    transcriptSnapshotCache.delete(oldest)
  }
  return read
}

export async function stableTranscript(
  path: string,
  runId: string,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string,
  startOffset?: number
): Promise<TranscriptRead> {
  path = await readableTranscriptPath(path, provider)
  // Recompute an exact JSONL turn anchor. Older persisted offsets were heuristic
  // byte rewinds and may begin inside a large prompt, so they are never evidence.
  startOffset = 0
  let previous = -1
  let latestIdentity: TranscriptSnapshotIdentity | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    let identity: TranscriptSnapshotIdentity
    try {
      const info = await stat(path)
      identity = {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs
      }
    } catch {
      return {
        stable: true,
        observed: false,
        ...(providerTurnId || promptHash ? { identityMatched: false } : {}),
        complete: true,
        events: [],
        observable: {
          tools: false,
          skills: false,
          mcps: false,
          hooks: false,
          usage: false,
          files: false,
          errors: false
        }
      }
    }
    latestIdentity = identity
    if (identity.size === previous) {
      startOffset = await transcriptAnchorOffset(path, identity.size, provider, promptHash, providerTurnId)
      return cachedTranscriptSnapshot({ path, startOffset, stable: true, runId, provider, promptHash, providerTurnId, identity })
    }
    previous = identity.size
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (latestIdentity) startOffset = await transcriptAnchorOffset(path, latestIdentity.size, provider, promptHash, providerTurnId)
  return latestIdentity
    ? cachedTranscriptSnapshot({
        path,
        startOffset,
        stable: false,
        runId,
        provider,
        promptHash,
        providerTurnId,
        identity: latestIdentity
      })
    : parseTranscriptSnapshot({
        path,
        endOffset: 0,
        startOffset,
        stable: false,
        runId,
        provider,
        promptHash,
        providerTurnId
      })
}
