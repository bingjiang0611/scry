import { randomUUID, createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { serialize } from 'node:v8'
import {
  appendTranscriptToTurns, createTranscriptParseState,
  type NormalizeCtx, type ParsedTurn, type TranscriptParseState
} from './normalize'

export const TRANSCRIPT_CACHE_MAX_ENTRIES = 8
export const TRANSCRIPT_CACHE_MAX_BYTES = 32 * 1024 * 1024
export const TRANSCRIPT_CACHE_IDLE_MS = 5 * 60_000

type SavedContext = Omit<NormalizeCtx, 'newId' | 'now' | 'contextTokensFromUsage'>
interface Checkpoint {
  parser: TranscriptParseState
  context: SavedContext
  idPrefix: string
  nextId: number
  now: string
}
interface Entry {
  dev: number
  ino: number
  hash: string
  completeHash: string
  completeBytes: number
  checkpoint: Checkpoint
  turns: ParsedTurn[]
  bytes: number
  expiresAt: number
}
export interface TranscriptFileRequest {
  path: string
  runId: string
  contextKey: string
  signal?: AbortSignal
}
export interface TranscriptFileResult {
  turns: ParsedTurn[]
  bytes: number
  parsedBytes: number
  cache: 'cold' | 'incremental' | 'hit'
}

const digest = (buffer: Uint8Array): string => createHash('sha256').update(buffer).digest('hex')

function checkpointFor(runId: string): Checkpoint {
  return { parser: createTranscriptParseState(), context: { runId },
    idPrefix: `history-${runId}-${randomUUID()}`, nextId: 0, now: new Date().toISOString() }
}

function forkCheckpoint(previous: Checkpoint): Checkpoint {
  const parser: TranscriptParseState = {
    ...previous.parser,
    turns: [...previous.parser.turns],
    cur: previous.parser.cur ? { ...previous.parser.cur, items: [...previous.parser.cur.items] } : null,
    pendingBeforeFirstTurn: [...previous.parser.pendingBeforeFirstTurn],
    seenAssistantUsage: new Set(previous.parser.seenAssistantUsage)
  }
  if (parser.cur) parser.turns[previous.parser.turns.indexOf(previous.parser.cur!)] = parser.cur
  const context: SavedContext = { ...previous.context }
  if (context.toolUseById) context.toolUseById = new Map(context.toolUseById)
  if (context.agentToolUseIds) context.agentToolUseIds = new Set(context.agentToolUseIds)
  if (context.agentTaskToolUseById) context.agentTaskToolUseById = new Map(context.agentTaskToolUseById)
  if (context.streamMessageIds) context.streamMessageIds = new Map(context.streamMessageIds)
  return { ...previous, parser, context }
}

function append(checkpoint: Checkpoint, content: string): void {
  const context: NormalizeCtx = { ...checkpoint.context,
    newId: () => `${checkpoint.idPrefix}-${checkpoint.nextId++}`, now: () => checkpoint.now }
  appendTranscriptToTurns(content, context, checkpoint.parser)
  const { newId: _newId, now: _now, contextTokensFromUsage: _accounting, ...saved } = context
  checkpoint.context = saved
}

/** A disposable parse cache, not evidence storage. Every read verifies exact
 * bytes, including the entire committed prefix: a short head/tail fingerprint
 * cannot prove a transcript wasn't rewritten while growing. This deliberately
 * saves JSON parsing rather than weakening integrity to save prefix I/O.
 * File size/mtime alone are never cache-hit authority.
 */
export class TranscriptFileCache {
  private entries = new Map<string, Entry>()
  private pending = new Map<string, Promise<TranscriptFileResult>>()
  private bytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private revision = 0

  async read(request: TranscriptFileRequest): Promise<TranscriptFileResult> {
    request.signal?.throwIfAborted()
    const key = JSON.stringify([request.contextKey, request.path, request.runId])
    let pending = this.pending.get(key)
    if (!pending) {
      const revision = this.revision
      pending = this.readFile(request, key, revision).finally(() => this.pending.delete(key))
      this.pending.set(key, pending)
    }
    const result = await pending
    request.signal?.throwIfAborted()
    // Main's enrichment and content externalization may mutate turns; never
    // expose the checkpoint to those callers or to another coalesced reader.
    return { ...result, turns: structuredClone(result.turns) }
  }

  clear(): void {
    this.revision += 1
    this.entries.clear()
    this.bytes = 0
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private async readFile(request: TranscriptFileRequest, key: string, revision: number): Promise<TranscriptFileResult> {
    const handle = await open(request.path, 'r')
    let buffer: Buffer
    let identity: { dev: number; ino: number }
    try {
      const before = await handle.stat()
      buffer = await handle.readFile()
      const after = await handle.stat()
      const current = await stat(request.path)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          buffer.length !== after.size || current.dev !== after.dev || current.ino !== after.ino ||
          current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
        throw new Error('transcript_changed_during_read')
      }
      identity = { dev: after.dev, ino: after.ino }
    } finally {
      await handle.close()
    }
    const previous = this.entries.get(key)
    const usable = previous && previous.expiresAt > Date.now() &&
      previous.dev === identity.dev && previous.ino === identity.ino ? previous : undefined
    const hash = digest(buffer)
    if (usable?.hash === hash) {
      this.entries.delete(key)
      usable.expiresAt = Date.now() + TRANSCRIPT_CACHE_IDLE_MS
      this.entries.set(key, usable)
      this.scheduleExpiry()
      return { turns: usable.turns, bytes: buffer.length, parsedBytes: 0, cache: 'hit' }
    }
    const incremental = usable && buffer.length >= usable.completeBytes &&
      digest(buffer.subarray(0, usable.completeBytes)) === usable.completeHash ? usable : undefined
    const checkpoint = incremental ? forkCheckpoint(incremental.checkpoint) : checkpointFor(request.runId)
    const start = incremental?.completeBytes ?? 0
    const completeBytes = buffer.lastIndexOf(10) + 1
    append(checkpoint, buffer.subarray(start, completeBytes).toString('utf8'))
    const preview = completeBytes === buffer.length ? checkpoint : forkCheckpoint(checkpoint)
    if (preview !== checkpoint) append(preview, buffer.subarray(completeBytes).toString('utf8'))
    const turns = preview.parser.turns
    const entry: Entry = { ...identity, hash, completeHash: digest(buffer.subarray(0, completeBytes)),
      completeBytes, checkpoint, turns, bytes: 0, expiresAt: Date.now() + TRANSCRIPT_CACHE_IDLE_MS }
    // Serialized checkpoint size is a bounded accounting estimate, not exact heap.
    entry.bytes = serialize(entry).byteLength
    if (revision === this.revision) {
      this.remove(key)
      if (entry.bytes <= TRANSCRIPT_CACHE_MAX_BYTES) {
        while (this.entries.size >= TRANSCRIPT_CACHE_MAX_ENTRIES || this.bytes + entry.bytes > TRANSCRIPT_CACHE_MAX_BYTES) {
          this.remove(this.entries.keys().next().value!)
        }
        this.entries.set(key, entry)
        this.bytes += entry.bytes
      }
      this.scheduleExpiry()
    }
    return { turns, bytes: buffer.length, parsedBytes: buffer.length - start, cache: incremental ? 'incremental' : 'cold' }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.bytes -= entry.bytes
    this.entries.delete(key)
  }

  private scheduleExpiry(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.entries.size === 0) return
    const expiresAt = Math.min(...Array.from(this.entries.values(), entry => entry.expiresAt))
    this.timer = setTimeout(() => {
      for (const [key, entry] of this.entries) if (entry.expiresAt <= Date.now()) this.remove(key)
      this.scheduleExpiry()
    }, Math.max(0, expiresAt - Date.now()))
    this.timer.unref()
  }
}
