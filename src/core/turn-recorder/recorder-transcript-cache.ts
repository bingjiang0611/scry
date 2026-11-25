import { createHash } from 'node:crypto'
import { basename, join, sep } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { parseTranscriptSnapshot } from './recorder-transcript-parse.js'
import { piTranscriptOffsets } from './recorder-pi-transcript.js'
import { nestedRecord, stringAt, type PiTranscriptAnchor, type TranscriptRead } from './recorder-contracts.js'
import { textContent } from './recorder-codex-calls.js'
import { recordTranscriptAnchorBytes, transcriptIdentity, type TranscriptSnapshotIdentity } from './recorder-transcript-io.js'
import { openTranscriptRead, statTranscript } from './recorder-transcript-fs.js'
import { updateHealth } from './store.js'

interface TranscriptSnapshotCacheEntry {
  key: string
  read: TranscriptRead
}

const TRANSCRIPT_SNAPSHOT_CACHE_LIMIT = 8
const transcriptSnapshotCache = new Map<string, TranscriptSnapshotCacheEntry>()
let transcriptSnapshotCacheHits = 0
let transcriptSnapshotCacheMisses = 0

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
  piTranscriptAnchor?: PiTranscriptAnchor
  endOffset?: number
  identity: TranscriptSnapshotIdentity
}): string {
  return JSON.stringify([
    args.path, args.startOffset ?? 0, args.stable, args.runId, args.provider,
    args.promptHash ?? '', args.providerTurnId ?? '', args.requestSetId ?? '', args.sessionId ?? '', args.cwd ?? '', args.identity.dev, args.identity.ino,
    args.identity.size, args.identity.mtimeMs, args.identity.ctimeMs,
    args.piTranscriptAnchor?.beforeEntryId ?? '', args.piTranscriptAnchor?.afterEntryId ?? '', args.endOffset ?? args.identity.size
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
    await statTranscript(path)
    return path
  } catch {
    if (provider !== 'codex') return path
  }
  const archived = archivedCodexTranscriptPath(path)
  if (!archived) return path
  try {
    await statTranscript(archived)
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
  offset: number
  scannedTo: number
}

interface AnchorCacheEntry extends AnchorScan {
  size: number
  dev: number
  ino: number
}

const ANCHOR_CACHE_LIMIT = 32
const anchorCache = new Map<string, AnchorCacheEntry>()

/**
 * Bytes one backwards anchor scan may read before it gives up and lets the caller fall back to a
 * bounded window. A scan is re-run for every pass that has no reusable cached anchor, so an
 * unbounded scan turns one big session into permanent load: the observed one walked 76 MiB per
 * pass. The floor also starts at the turn's recorded start offset when it has one.
 */
export const TRANSCRIPT_ANCHOR_SCAN_LIMIT_BYTES = 64 * 1024 * 1024

/**
 * Longest single JSONL line a scan keeps across chunk boundaries. A quoted tool result can be tens
 * of MiB on one line; concatenating it chunk by chunk copies the whole line on every step, so the
 * scan was quadratic in that line's length. Past this bound the line cannot be an anchor line (it
 * is a record body), and the scan treats the partial line as a boundary instead of growing it.
 */
export const TRANSCRIPT_ANCHOR_LINE_LIMIT_BYTES = 4 * 1024 * 1024

/**
 * How far before a turn's recorded start its anchor line may sit. A provider writes the prompt row
 * and then the hook fires, or the reverse; both orders put the anchor inside this distance. That is
 * what lets a later pass start at the turn instead of at the session.
 */
export const TRANSCRIPT_ANCHOR_LOOKBACK_BYTES = 8 * 1024 * 1024

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

async function latestAnchorFrom(
  path: string,
  from: number,
  endOffset: number,
  provider: ProviderId,
  promptHash: string | undefined,
  providerTurnId: string | undefined,
  skipOversized: () => void
): Promise<AnchorScan> {
  if (from >= endOffset) return { offset: -1, scannedTo: from }
  const handle = await openTranscriptRead(path)
  const chunkBytes = 1024 * 1024
  let cursor = from
  let pending = Buffer.alloc(0)
  let pendingStart = from
  let latest = -1
  let discarding = false
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
        const length = newline - lineStart
        if (!discarding && length > TRANSCRIPT_ANCHOR_LINE_LIMIT_BYTES) skipOversized()
        if (!discarding && length > 0 && length <= TRANSCRIPT_ANCHOR_LINE_LIMIT_BYTES && transcriptLineAnchor(
          combined.subarray(lineStart, newline).toString('utf8'), provider, promptHash, providerTurnId
        )) {
          latest = Math.max(latest, Math.max(0, pendingStart + lineStart - 1))
        }
        discarding = false
        lineStart = newline + 1
      }
      if (!discarding && combined.length - lineStart > TRANSCRIPT_ANCHOR_LINE_LIMIT_BYTES) {
        skipOversized()
        discarding = true
      }
      pending = discarding ? Buffer.alloc(0) : Buffer.from(combined.subarray(lineStart))
      pendingStart += lineStart
      cursor += bytesRead
      if (discarding) pendingStart = cursor
    }
  } finally {
    await handle.close()
  }
  if (cursor === endOffset && pending.length && transcriptLineAnchor(pending.toString('utf8'), provider, promptHash, providerTurnId)) {
    latest = Math.max(latest, Math.max(0, pendingStart - 1))
  }
  // Do not resume the next pass inside a discarded line.
  return { offset: latest, scannedTo: discarding ? endOffset + 1 : pendingStart }
}

async function lineAtAnchor(path: string, offset: number): Promise<string | undefined> {
  const handle = await openTranscriptRead(path)
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

async function anchorOffsetFor(
  path: string,
  endOffset: number,
  provider: ProviderId,
  promptHash: string | undefined,
  providerTurnId: string | undefined,
  floor: number,
  dataRoot?: string
): Promise<number> {
  let oversized = 0
  const skipOversized = () => { oversized++ }
  try {
    return await selectAnchorOffset(path, endOffset, provider, promptHash, providerTurnId, floor, skipOversized)
  } finally {
    if (oversized && dataRoot) {
      // Diagnostics must not turn a readable transcript into a failed recovery.
      await updateHealth(dataRoot, { increment: { oversizedTranscriptAnchorLines: oversized } }).catch(() => undefined)
    }
  }
}

async function selectAnchorOffset(
  path: string,
  endOffset: number,
  provider: ProviderId,
  promptHash: string | undefined,
  providerTurnId: string | undefined,
  floor: number,
  skipOversized: () => void
): Promise<number> {
  if (endOffset <= 0 || !promptHash && !providerTurnId) return 0
  const scanBackwards = async (): Promise<AnchorScan> => {
    const scan = (at: number) => transcriptAnchorOffset(path, endOffset, provider, promptHash, providerTurnId, at, skipOversized)
    const hinted = await scan(floor)
    // Replay can observe a much later file size than the hook's own turn. Retry only if removing
    // the hint actually expands the recent-byte search; offset zero is a valid match, not a miss.
    return hinted.offset < 0 && floor > Math.max(0, endOffset - TRANSCRIPT_ANCHOR_SCAN_LIMIT_BYTES)
      ? scan(0)
      : hinted
  }
  // A Codex turn is anchored on its own `task_started` line, which `lineAtAnchor` can re-prove from
  // one line when the turn id is known. Without that id the backwards scan is the only authority and
  // it runs every pass: that is the every-pass cost this cache exists to remove.
  const reProvable = provider !== 'codex' || !!providerTurnId
  if (!reProvable || !promptHash && !providerTurnId) {
    return Math.max(0, (await scanBackwards()).offset)
  }
  // A Codex `user_message` is an anchor for the backwards scan only (it says where the prompt is),
  // not for the turn boundary the window must start at. Judged with the hash it would look like a
  // newer, better anchor and move the window past `task_started`.
  const proofHash = provider === 'codex' ? undefined : promptHash
  const key = JSON.stringify([path, provider, promptHash ?? '', providerTurnId ?? ''])
  const cached = anchorCache.get(key)
  // An out-of-range cursor (for example at a frozen Stop boundary) or a large burst of
  // new data needs a fresh bounded scan, not an unbounded forward walk from the old cursor.
  if (cached && cached.scannedTo <= endOffset && endOffset - cached.scannedTo <= TRANSCRIPT_ANCHOR_SCAN_LIMIT_BYTES) {
    let reusable = false
    try {
      const info = await statTranscript(path)
      if (info.dev === cached.dev && info.ino === cached.ino && info.size >= cached.size) {
        const line = await lineAtAnchor(path, cached.offset)
        const proof = line === undefined ? undefined : transcriptLineAnchor(line, provider, proofHash, providerTurnId)
        reusable = provider === 'codex' ? proof === 'turn' : !!proof
      }
    } catch {
    }
    if (reusable) {
      const newer = await latestAnchorFrom(path, cached.scannedTo, endOffset, provider, proofHash, providerTurnId, skipOversized)
      const offset = newer.offset >= 0 ? newer.offset : cached.offset
      if (newer.scannedTo <= endOffset) {
        rememberAnchor(key, { offset, scannedTo: newer.scannedTo, size: endOffset, dev: cached.dev, ino: cached.ino })
      } else {
        anchorCache.delete(key)
      }
      return offset
    }
    anchorCache.delete(key)
  }
  const scan = await scanBackwards()
  if (scan.offset >= 0) {
    try {
      const info = await statTranscript(path)
      rememberAnchor(key, { ...scan, size: endOffset, dev: info.dev, ino: info.ino })
    } catch {}
  }
  return Math.max(0, scan.offset)
}

async function transcriptAnchorOffset(
  path: string,
  endOffset: number,
  provider: ProviderId,
  promptHash: string | undefined,
  providerTurnId: string | undefined,
  /** Lowest byte the scan may read. The caller passes a turn's recorded start, so a scan stays
   * inside one turn instead of walking the session; 0 means "the whole session, up to the limit". */
  floor: number,
  skipOversized: () => void
): Promise<AnchorScan> {
  const handle = await openTranscriptRead(path)
  const chunkBytes = 1024 * 1024
  // Bounded both ways: never below the caller's floor, never more than one scan limit back. Without
  // the limit a session that never matches costs the whole file on every pass.
  const lowest = Math.max(0, Math.min(Math.max(0, floor), endOffset), endOffset - TRANSCRIPT_ANCHOR_SCAN_LIMIT_BYTES)
  let scannedTo = 0
  let cursor = endOffset
  let suffix = Buffer.alloc(0)
  let discarding = false
  let matchedUserOffset: number | undefined
  let matchedTurnOffset: number | undefined
  try {
    while (cursor > lowest) {
      const start = Math.max(lowest, cursor - chunkBytes)
      const chunk = Buffer.allocUnsafe(cursor - start)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start)
      recordTranscriptAnchorBytes(bytesRead)
      if (bytesRead !== chunk.length) return { offset: -1, scannedTo: 0 }
      if (scannedTo === 0) {
        const newline = chunk.lastIndexOf(0x0a)
        if (newline >= 0) scannedTo = start + newline + 1
      }
      // If a line crossed the limit in the previous chunk, drop the rest of that same line.
      const lastNewline = discarding ? chunk.lastIndexOf(0x0a) : -1
      if (discarding && lastNewline < 0) {
        cursor = start
        continue
      }
      const combined = discarding ? chunk.subarray(0, lastNewline) : Buffer.concat([chunk, suffix])
      discarding = false
      let lineEnd = combined.length
      // `lastIndexOf` is the native scan; a byte-per-byte loop here made a NUL-filled or
      // record-body-heavy region cost seconds per pass instead of milliseconds.
      for (let index = combined.lastIndexOf(0x0a); index >= 0; index = index > 0 ? combined.lastIndexOf(0x0a, index - 1) : -1) {
        const lineStart = index + 1
        const length = lineEnd - lineStart
        if (length > TRANSCRIPT_ANCHOR_LINE_LIMIT_BYTES) skipOversized()
        if (length > 0 && length <= TRANSCRIPT_ANCHOR_LINE_LIMIT_BYTES) {
          const absoluteOffset = start + lineStart
          const anchor = transcriptLineAnchor(combined.subarray(lineStart, lineEnd).toString('utf8'), provider, promptHash, providerTurnId)
          const windowOffset = Math.max(0, absoluteOffset - 1)
          if (provider !== 'codex') {
            if (anchor === 'turn') return { offset: windowOffset, scannedTo }
          } else {
            const anyAnchor = transcriptLineAnchor(
              combined.subarray(lineStart, lineEnd).toString('utf8'), provider, undefined, undefined
            )
            if (matchedTurnOffset != null && anyAnchor === 'turn') return { offset: matchedTurnOffset, scannedTo }
            if (anchor === 'turn' || matchedUserOffset != null && anyAnchor === 'turn') {
              matchedTurnOffset = windowOffset
            } else if (anchor === 'user' && matchedUserOffset == null) {
              matchedUserOffset = windowOffset
            }
          }
        }
        lineEnd = index
      }
      suffix = Buffer.from(combined.subarray(0, lineEnd))
      // NUL cannot occur in a valid JSONL record. Sparse/uninitialized prefixes are
      // therefore a hard format boundary, not evidence that must be loaded to byte 0.
      if (matchedTurnOffset != null && suffix.includes(0)) return { offset: matchedTurnOffset, scannedTo }
      if (suffix.length > TRANSCRIPT_ANCHOR_LINE_LIMIT_BYTES) {
        skipOversized()
        suffix = Buffer.alloc(0)
        discarding = true
      }
      cursor = start
    }
    if (suffix.length && lowest === 0) {
      const firstLine = suffix.toString('utf8')
      const anchor = transcriptLineAnchor(firstLine, provider, promptHash, providerTurnId)
      if (anchor === 'turn') return { offset: 0, scannedTo }
      if (provider === 'codex' && matchedTurnOffset != null && transcriptLineAnchor(firstLine, provider) === 'turn') return { offset: matchedTurnOffset, scannedTo }
      if (anchor === 'user' && matchedUserOffset == null) matchedUserOffset = 0
    }
    return { offset: matchedTurnOffset ?? matchedUserOffset ?? -1, scannedTo }
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
  piTranscriptAnchor?: PiTranscriptAnchor
  endOffset?: number
  identity: TranscriptSnapshotIdentity
}, key = transcriptSnapshotCacheKey(args)): Promise<TranscriptRead> {
  const cached = transcriptSnapshotCache.get(key)
  if (cached) {
    transcriptSnapshotCache.delete(key)
    transcriptSnapshotCache.set(key, cached)
    transcriptSnapshotCacheHits++
    return cached.read
  }
  transcriptSnapshotCacheMisses++
  const read = await parseTranscriptSnapshot({ ...args, endOffset: args.endOffset ?? args.identity.size })
  const hasChildSources = read.events.some(event => event.kind === 'agent' || event.runtimeMetadata?.childTranscript !== undefined)
  if ((!args.stable || read.stable) && !hasChildSources) transcriptSnapshotCache.set(key, { key, read })
  while (transcriptSnapshotCache.size > TRANSCRIPT_SNAPSHOT_CACHE_LIMIT) {
    const oldest = transcriptSnapshotCache.keys().next().value
    if (typeof oldest !== 'string') break
    transcriptSnapshotCache.delete(oldest)
  }
  return read
}

function missingTranscript(providerTurnId?: string, promptHash?: string): TranscriptRead {
  return {
    stable: true,
    observed: false,
    ...(providerTurnId || promptHash ? { identityMatched: false } : {}),
    complete: true,
    events: [],
    observable: { tools: false, skills: false, mcps: false, hooks: false, usage: false, files: false, errors: false }
  }
}

export async function stableTranscript(
  path: string,
  runId: string,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string,
  /**
   * Byte at which this turn's own rows begin, recorded when the turn opened. It is a hint for the
   * anchor scan, never evidence: `null` means the recorder could not read it at open, which must not
   * be spelled `0` ("the file started here").
   */
  startOffset?: number | null,
  requestSetId?: string,
  sessionId?: string,
  cwd?: string,
  piTranscriptAnchor?: PiTranscriptAnchor,
  /**
   * Frozen end of the readable window. A captured session records this at stop time so the next
   * prompt, written after stop, can never be parsed back into the turn that just ended.
   */
  endOffsetLimit?: number,
  dataRoot?: string
): Promise<TranscriptRead> {
  path = await readableTranscriptPath(path, provider)
  if (provider === 'pi' && !piTranscriptAnchor) {
    return { stable: true, observed: false, complete: false, events: [], observable: {
      tools: false, skills: false, mcps: false, hooks: false, usage: false, files: false, errors: false
    } }
  }
  // Recompute an exact JSONL turn anchor. Older persisted offsets were heuristic
  // byte rewinds and may begin inside a large prompt, so they are never evidence. They still bound
  // where this turn's anchor can be, so the scan starts one window before the recorded byte instead
  // of walking the whole session; an unknown offset searches the last window only.
  const anchorFloor = startOffset != null && startOffset > 0
    ? Math.max(0, startOffset - TRANSCRIPT_ANCHOR_LOOKBACK_BYTES)
    : 0
  startOffset = 0
  const selectionKey = (identity: TranscriptSnapshotIdentity, stable = true) => transcriptSnapshotCacheKey({
    path, stable, runId, provider, promptHash, providerTurnId, requestSetId, sessionId, cwd,
    piTranscriptAnchor, endOffset: endOffsetLimit, identity
  })
  const cachedSelection = (identity: TranscriptSnapshotIdentity): TranscriptRead | undefined => {
    const key = selectionKey(identity)
    const cached = transcriptSnapshotCache.get(key)
    if (!cached) return undefined
    transcriptSnapshotCache.delete(key)
    transcriptSnapshotCache.set(key, cached)
    transcriptSnapshotCacheHits++
    return cached.read
  }
  let previous = -1
  let latestIdentity: TranscriptSnapshotIdentity | undefined
  if (endOffsetLimit != null && !(provider === 'pi' && piTranscriptAnchor)) {
    let frozenIdentity: TranscriptSnapshotIdentity
    try {
      frozenIdentity = transcriptIdentity(await statTranscript(path))
    } catch {
      return missingTranscript(providerTurnId, promptHash)
    }
    const cached = cachedSelection(frozenIdentity)
    if (cached) return cached
    const boundary = Math.min(frozenIdentity.size, Math.max(0, endOffsetLimit))
    return cachedTranscriptSnapshot({
      path,
      startOffset: await anchorOffsetFor(path, boundary, provider, promptHash, providerTurnId, anchorFloor, dataRoot),
      stable: true,
      runId,
      provider,
      promptHash,
      providerTurnId,
      requestSetId,
      sessionId,
      cwd,
      endOffset: boundary,
      identity: frozenIdentity
    }, selectionKey(frozenIdentity))
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let identity: TranscriptSnapshotIdentity
    try {
      identity = transcriptIdentity(await statTranscript(path))
    } catch {
      return missingTranscript(providerTurnId, promptHash)
    }
    latestIdentity = identity
    const cached = cachedSelection(identity)
    if (cached) return cached
    if (identity.size === previous) {
      let endOffset = identity.size
      if (provider === 'pi' && piTranscriptAnchor) {
        const offsets = await piTranscriptOffsets(path, identity.size, piTranscriptAnchor)
        startOffset = offsets.startOffset
        endOffset = offsets.endOffset
      } else {
        startOffset = await anchorOffsetFor(path, identity.size, provider, promptHash, providerTurnId, anchorFloor, dataRoot)
      }
      return cachedTranscriptSnapshot({ path, startOffset, stable: true, runId, provider, promptHash, providerTurnId, requestSetId, sessionId, cwd, piTranscriptAnchor, endOffset, identity }, selectionKey(identity))
    }
    previous = identity.size
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  let endOffset = latestIdentity?.size
  if (latestIdentity && provider === 'pi' && piTranscriptAnchor) {
    const offsets = await piTranscriptOffsets(path, latestIdentity.size, piTranscriptAnchor)
    startOffset = offsets.startOffset
    endOffset = offsets.endOffset
  } else if (latestIdentity) {
    startOffset = await anchorOffsetFor(path, latestIdentity.size, provider, promptHash, providerTurnId, anchorFloor, dataRoot)
  }
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
        piTranscriptAnchor,
        endOffset,
        identity: latestIdentity
      }, selectionKey(latestIdentity, false))
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
