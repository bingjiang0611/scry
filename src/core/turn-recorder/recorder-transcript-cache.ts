import { createHash } from 'node:crypto'
import { open as openFile, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { parseTranscriptSnapshot } from './recorder-transcript-parse.js'
import { nestedRecord, stringAt, type TranscriptRead } from './recorder-contracts.js'
import { textContent } from './recorder-codex-calls.js'
import { recordTranscriptAnchorBytes, type TranscriptSnapshotIdentity } from './recorder-transcript-io.js'

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
  requestSetId?: string
  sessionId?: string
  cwd?: string
  identity: TranscriptSnapshotIdentity
}): string {
  return JSON.stringify([
    args.path, args.startOffset ?? 0, args.stable, args.runId, args.provider,
    args.promptHash ?? '', args.providerTurnId ?? '', args.requestSetId ?? '', args.sessionId ?? '', args.cwd ?? '', args.identity.dev, args.identity.ino,
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
  if (row.type !== 'user' || row.parent_tool_use_id != null || row.isSidechain === true ||
      row.isMeta === true || row.isSynthetic === true || row.isReplay === true || row.forkedFrom) return undefined
  const content = nestedRecord(row, 'message')?.content
  if (Array.isArray(content) && content.some(block => block && typeof block === 'object' && block.type === 'tool_result')) return undefined
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

interface AnchorScan {
  /** Byte offset the window starts at (the newline before the anchor line, or 0). */
  offset: number
  /** End of the last newline-terminated line; an unfinished tail must be rescanned. */
  scannedTo: number
}

interface AnchorCacheEntry extends AnchorScan {
  size: number
  dev: number
  ino: number
}

const ANCHOR_CACHE_LIMIT = 32
const anchorCache = new Map<string, AnchorCacheEntry>()

export function resetTranscriptAnchorCache(): void {
  anchorCache.clear()
}

function rememberAnchor(key: string, entry: AnchorCacheEntry): void {
  anchorCache.delete(key)
  anchorCache.set(key, entry)
  while (anchorCache.size > ANCHOR_CACHE_LIMIT) {
    const oldest = anchorCache.keys().next().value
    if (typeof oldest !== 'string') break
    anchorCache.delete(oldest)
  }
}

/**
 * The newest matching anchor in [from, endOffset), read forward only. Returns -1 when that region
 * holds none. A cached anchor is a candidate, never the answer: the same prompt can be sent twice,
 * and the full backwards scan always returns the latest match.
 */
async function latestAnchorFrom(
  path: string,
  from: number,
  endOffset: number,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string
): Promise<AnchorScan> {
  if (from >= endOffset) return { offset: -1, scannedTo: from }
  const handle = await openFile(path, 'r')
  const chunkBytes = 1024 * 1024
  let cursor = from
  let pending = Buffer.alloc(0)
  let pendingStart = from
  let latest = -1
  try {
    while (cursor < endOffset) {
      const length = Math.min(chunkBytes, endOffset - cursor)
      const chunk = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(chunk, 0, length, cursor)
      if (bytesRead !== length) break
      recordTranscriptAnchorBytes(bytesRead)
      const combined = pending.length ? Buffer.concat([pending, chunk]) : chunk
      let lineStart = 0
      for (;;) {
        const newline = combined.indexOf(0x0a, lineStart)
        if (newline < 0) break
        if (newline > lineStart && transcriptLineAnchor(
          combined.subarray(lineStart, newline).toString('utf8'), provider, promptHash, providerTurnId
        )) {
          latest = Math.max(latest, Math.max(0, pendingStart + lineStart - 1))
        }
        lineStart = newline + 1
      }
      pending = Buffer.from(combined.subarray(lineStart))
      pendingStart += lineStart
      cursor += bytesRead
    }
  } finally {
    await handle.close()
  }
  // A complete JSON value at EOF is an anchor too, but its line must be rescanned if appended.
  if (cursor === endOffset && pending.length && transcriptLineAnchor(pending.toString('utf8'), provider, promptHash, providerTurnId)) {
    latest = Math.max(latest, Math.max(0, pendingStart - 1))
  }
  return { offset: latest, scannedTo: pendingStart }
}

/** Read the single JSONL line a cached offset points at (the offset may be its preceding newline). */
async function lineAtAnchor(path: string, offset: number): Promise<string | undefined> {
  const handle = await openFile(path, 'r')
  const buffer = Buffer.allocUnsafe(8192)
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    recordTranscriptAnchorBytes(bytesRead)
    const view = buffer.subarray(0, bytesRead)
    const start = view[0] === 0x0a ? 1 : 0
    const end = view.indexOf(0x0a, start)
    if (end < 0) return undefined
    return view.subarray(start, end).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Reuse a previously located anchor for the same prompt identity.
 *
 * Correctness comes from re-proving every part of the claim: the path is the same file, the line at
 * the cached offset still passes the anchor test, and only bytes appended since the last scan are
 * searched for a newer match. Anything unprovable falls back to the full backwards scan.
 */
async function anchorOffsetFor(
  path: string,
  endOffset: number,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string
): Promise<number> {
  // Codex anchors are found through a forward state machine over each scanned chunk, so a single
  // line cannot re-prove one; its scan also stops at the turn boundary, which is the same work.
  if (provider === 'codex' || !promptHash && !providerTurnId) {
    return (await transcriptAnchorOffset(path, endOffset, provider, promptHash, providerTurnId)).offset
  }
  const key = JSON.stringify([path, provider, promptHash ?? '', providerTurnId ?? ''])
  const cached = anchorCache.get(key)
  if (cached) {
    let reusable = false
    try {
      const info = await stat(path)
      // Append-only growth is proven by dev/ino identity and a size that still covers what was
      // already scanned; a replaced or truncated file cannot reuse this offset.
      if (info.dev === cached.dev && info.ino === cached.ino && info.size >= cached.size) {
        const line = await lineAtAnchor(path, cached.offset)
        reusable = line !== undefined && !!transcriptLineAnchor(line, provider, promptHash, providerTurnId)
      }
    } catch {
      // An unreadable path falls through to the authoritative scan.
    }
    if (reusable) {
      const newer = await latestAnchorFrom(path, cached.scannedTo, endOffset, provider, promptHash, providerTurnId)
      const offset = newer.offset >= 0 ? newer.offset : cached.offset
      rememberAnchor(key, { offset, scannedTo: newer.scannedTo, size: endOffset, dev: cached.dev, ino: cached.ino })
      return offset
    }
    anchorCache.delete(key)
  }
  const scan = await transcriptAnchorOffset(path, endOffset, provider, promptHash, providerTurnId)
  try {
    const info = await stat(path)
    rememberAnchor(key, { ...scan, size: endOffset, dev: info.dev, ino: info.ino })
  } catch {}
  return scan.offset
}

async function transcriptAnchorOffset(
  path: string,
  endOffset: number,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string
): Promise<AnchorScan> {
  if (endOffset <= 0 || !promptHash && !providerTurnId) return { offset: 0, scannedTo: 0 }
  const handle = await openFile(path, 'r')
  const chunkBytes = 1024 * 1024
  let scannedTo = 0
  let cursor = endOffset
  let suffix = Buffer.alloc(0)
  let matchedUserOffset: number | undefined
  let matchedTurnOffset: number | undefined
  try {
    while (cursor > 0) {
      const start = Math.max(0, cursor - chunkBytes)
      const chunk = Buffer.allocUnsafe(cursor - start)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start)
      recordTranscriptAnchorBytes(bytesRead)
      if (bytesRead !== chunk.length) return { offset: 0, scannedTo: 0 }
      if (scannedTo === 0) {
        const newline = chunk.lastIndexOf(0x0a)
        if (newline >= 0) scannedTo = start + newline + 1
      }
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
            if (anchor === 'turn') return { offset: windowOffset, scannedTo }
          } else {
            const anyAnchor = transcriptLineAnchor(
              combined.subarray(lineStart, lineEnd).toString('utf8'), provider, undefined, undefined
            )
            if (matchedTurnOffset != null && anyAnchor === 'turn') return { offset: windowOffset, scannedTo }
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
      if (matchedTurnOffset != null && suffix.includes(0)) return { offset: matchedTurnOffset, scannedTo }
      cursor = start
    }
    if (suffix.length) {
      const firstLine = suffix.toString('utf8')
      const anchor = transcriptLineAnchor(firstLine, provider, promptHash, providerTurnId)
      if (anchor === 'turn') return { offset: 0, scannedTo }
      if (provider === 'codex' && matchedTurnOffset != null && transcriptLineAnchor(firstLine, provider) === 'turn') return { offset: 0, scannedTo }
      if (anchor === 'user' && matchedUserOffset == null) matchedUserOffset = 0
    }
    return { offset: matchedTurnOffset ?? matchedUserOffset ?? 0, scannedTo }
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
  requestSetId?: string
  sessionId?: string
  cwd?: string
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
  // Agent sidecars have identities independent of the root log. Do not cache a
  // cross-file projection under only the root's identity (including missing children).
  const hasChildSources = read.events.some(event => event.kind === 'agent' || event.runtimeMetadata?.childTranscript !== undefined)
  if ((!args.stable || read.stable) && !hasChildSources) transcriptSnapshotCache.set(key, { key, read })
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
  startOffset?: number,
  requestSetId?: string,
  sessionId?: string,
  cwd?: string
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
      startOffset = await anchorOffsetFor(path, identity.size, provider, promptHash, providerTurnId)
      return cachedTranscriptSnapshot({ path, startOffset, stable: true, runId, provider, promptHash, providerTurnId, requestSetId, sessionId, cwd, identity })
    }
    previous = identity.size
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (latestIdentity) startOffset = await anchorOffsetFor(path, latestIdentity.size, provider, promptHash, providerTurnId)
  return latestIdentity
    ? cachedTranscriptSnapshot({
        path,
        startOffset,
        stable: false,
        runId,
        provider,
        promptHash,
        providerTurnId,
        requestSetId,
        sessionId,
        cwd,
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
        providerTurnId,
        requestSetId,
        sessionId,
        cwd
      })
}
