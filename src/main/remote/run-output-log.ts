// Per-run, cursor-based OUTPUT log: the assistant's real trace
// CONTENT (text, reasoning, tool activity), streamed to an authorized device so
// the phone renders the actual run output rather than only the ledger lifecycle.
//
// Provenance & honesty (CLAUDE.md):
//   - This is the transcript/trace SHADOW *content*, distinct from the durable
//     ledger (lifecycle-only, non-secret markers) and from canonical usage. It
//     carries NO token/cost totals and must never be double-counted as usage;
//     the ledger `result` marker remains the authority for exact usage.
//   - Content is stored verbatim and may include credentials; every chunk remains byte-bounded.
//   - Production injects a durable store and retains every exposed chunk.
//     The bounded in-memory mode remains an explicit fallback for isolated uses/tests;
//     it appends ONE truthful `truncated` marker instead of silently dropping data.
//   - Reads are authorized upstream by the verified owner-device peer cert (the
//     same check as poll); this module holds no trust of its own.

export type OutputChunkKind = 'output' | 'reasoning' | 'tool' | 'tool_result' | 'truncated'

export interface OutputChunk {
  // Strictly-increasing per-run sequence; the device polls with the last seq it
  // has seen (0 initially) and receives strictly-after chunks.
  seq: number
  at: number
  runId: string
  kind: OutputChunkKind
  text: string
}

export interface RunOutputPage {
  chunks: OutputChunk[]
  cursor: number
}

export interface RunOutputStore {
  append(chunk: Omit<OutputChunk, 'seq'>): OutputChunk | Promise<OutputChunk>
  appendBatch?(chunks: Array<Omit<OutputChunk, 'seq'>>): OutputChunk[] | Promise<OutputChunk[]>
  since(runId: string, cursor: number, pageSize?: number): RunOutputPage | Promise<RunOutputPage>
  close(): void | Promise<void>
}

// Bounds: a single pathological run cannot exhaust host memory, and a device
// poll frame stays small. Generous enough for a real turn's visible output.
const MAX_CHUNK_BYTES = 16 * 1024
const MAX_BYTES_PER_RUN = 1_000_000
const MAX_EVENTS_PER_RUN = 4_000
const DEFAULT_PAGE = 200
const MAX_RUNS = 256
const MAX_PENDING_BYTES = 512 * 1024
const MAX_PENDING_CHUNKS = 4_000

interface RunBuffer {
  seq: number
  bytes: number
  chunks: OutputChunk[]
  truncated: boolean
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

function* splitUtf8(text: string, maxBytes: number): Generator<string> {
  // Walk once, yielding slices lazily. Do not strip U+FFFD: it may be actual Provider text.
  let start = 0
  let bytes = 0
  for (let index = 0; index < text.length;) {
    const code = text.codePointAt(index)!
    const width = code > 0xffff ? 2 : 1
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
    if (bytes + size > maxBytes) {
      yield text.slice(start, index)
      start = index
      bytes = 0
    }
    bytes += size
    index += width
  }
  if (start < text.length || text.length === 0) yield text.slice(start)
}

export class RunOutputLog {
  // Insertion-ordered so the oldest run is evicted first when MAX_RUNS is hit.
  #runs = new Map<string, RunBuffer>()
  #store?: RunOutputStore
  #failedPersistentRuns = new Set<string>()
  #pendingGapAfter = new Set<string>()
  #persistenceErrors = new Map<string, Error>()
  #pending = new Map<string, Array<Omit<OutputChunk, 'seq'>>>()
  #pendingBytes = 0
  #pendingChunks = 0
  #flushScheduled = false
  #draining?: Promise<void>

  constructor(options: { store?: RunOutputStore } = {}) {
    this.#store = options.store
  }

  // Append one content chunk for a run. Best-effort and never throws to the
  // caller: a run's execution must not fail because output could not be cached.
  append(runId: string, chunk: { kind: OutputChunkKind; text: string }): void {
    if (typeof runId !== 'string' || runId.length === 0 || runId.length > 128) return
    const text = typeof chunk.text === 'string' ? chunk.text : ''
    if (text.length === 0 && chunk.kind !== 'truncated') return
    if (this.#store) {
      for (const piece of splitUtf8(text, MAX_CHUNK_BYTES)) {
        const bytes = byteLength(piece)
        // Bound the whole pending queue, including tiny events across different runs.
        if (this.#pendingBytes + bytes > MAX_PENDING_BYTES || this.#pendingChunks >= MAX_PENDING_CHUNKS) {
          // This loss happened after already-queued content, so its marker must
          // follow that content rather than being prepended like an unknown store write.
          this.#pendingGapAfter.add(runId)
          this.#persistenceErrors.set(runId, new Error('output_capture_queue_full'))
          break
        }
        const pending = this.#pending.get(runId) ?? []
        pending.push({ runId, at: Date.now(), kind: chunk.kind, text: piece })
        this.#pending.set(runId, pending)
        this.#pendingBytes += bytes
        this.#pendingChunks++
      }
      this.#scheduleFlush()
      return
    }
    let buffer = this.#runs.get(runId)
    if (!buffer) {
      if (this.#runs.size >= MAX_RUNS) {
        const oldest = this.#runs.keys().next().value
        if (oldest !== undefined) this.#runs.delete(oldest)
      }
      buffer = { seq: 0, bytes: 0, chunks: [], truncated: false }
      this.#runs.set(runId, buffer)
    }
    if (buffer.truncated) return
    const markTruncated = (reason: string): void => {
      if (buffer!.truncated) return
      buffer!.truncated = true
      buffer!.seq += 1
      buffer!.chunks.push({ seq: buffer!.seq, at: Date.now(), runId, kind: 'truncated', text: reason })
    }
    if (chunk.kind === 'truncated') {
      markTruncated(text || 'output truncated upstream')
      return
    }
    // A transport chunk is a framing detail, not a content boundary. Split an
    // oversized chunk into complete UTF-8 pieces so its tail is not silently
    // discarded. Only the documented per-run cache bounds may lose content,
    // and those always append a visible truncated marker.
    for (const piece of splitUtf8(text, MAX_CHUNK_BYTES)) {
      const bytes = byteLength(piece)
      if (buffer.chunks.length >= MAX_EVENTS_PER_RUN || buffer.bytes + bytes > MAX_BYTES_PER_RUN) {
        markTruncated('output truncated (host live-cache limit reached)')
        return
      }
      buffer.seq += 1
      buffer.bytes += bytes
      buffer.chunks.push({ seq: buffer.seq, at: Date.now(), runId, kind: chunk.kind, text: piece })
    }
  }

  // Return chunks strictly after `cursor` for a run (bounded page), plus the
  // next cursor. An unknown/evicted run yields an empty page at the same cursor.
  async flush(runId: string): Promise<void> {
    if (!this.#store) return
    await this.#ensureDrain()
    if (this.#failedPersistentRuns.has(runId) || this.#pendingGapAfter.has(runId)) {
      this.#failedPersistentRuns.delete(runId)
      this.#pendingGapAfter.delete(runId)
      try {
        await this.#persist([{ runId, at: Date.now(), kind: 'truncated', text: 'output incomplete (durable capture was temporarily unavailable)' }])
      } catch (error) {
        this.#rememberFailure(runId, error)
      }
    }
    const failure = this.#persistenceErrors.get(runId)
    if (failure) {
      this.#persistenceErrors.delete(runId)
      throw failure
    }
  }

  async since(runId: string, cursor: number, pageSize = DEFAULT_PAGE): Promise<RunOutputPage> {
    const start = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
    if (this.#store) {
      await this.#ensureDrain()
      // A durable truncation marker makes partial output readable. Keep the
      // historical capture error for terminal flush, not as a permanent read barrier.
      if (this.#failedPersistentRuns.has(runId) || this.#pendingGapAfter.has(runId)) {
        throw this.#persistenceErrors.get(runId) ?? new Error('output_capture_gap_pending')
      }
      return this.#store.since(runId, start, pageSize)
    }
    const buffer = this.#runs.get(runId)
    if (!buffer) return { chunks: [], cursor: start }
    const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, DEFAULT_PAGE) : DEFAULT_PAGE
    const chunks = buffer.chunks.filter((c) => c.seq > start).slice(0, size)
    const next = chunks.length > 0 ? chunks[chunks.length - 1].seq : start
    return { chunks: chunks.map((c) => ({ ...c })), cursor: next }
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return
    this.#flushScheduled = true
    queueMicrotask(() => {
      this.#flushScheduled = false
      void this.#ensureDrain()
    })
  }

  async #persist(chunks: Array<Omit<OutputChunk, 'seq'>>): Promise<void> {
    if (!this.#store || chunks.length === 0) return
    if (this.#store.appendBatch) await this.#store.appendBatch(chunks)
    else for (const chunk of chunks) await this.#store.append(chunk)
  }

  #ensureDrain(): Promise<void> {
    if (!this.#draining) {
      this.#draining = this.#drainPersistent().finally(() => { this.#draining = undefined })
    }
    return this.#draining
  }

  async #drainPersistent(): Promise<void> {
    while (this.#pending.size > 0) {
      const next = this.#pending.entries().next().value as [string, Array<Omit<OutputChunk, 'seq'>>] | undefined
      if (!next) break
      const [runId, chunks] = next
      this.#pending.delete(runId)
      this.#pendingChunks -= chunks.length
      this.#pendingBytes -= chunks.reduce((sum, chunk) => sum + byteLength(chunk.text), 0)
      const before = this.#failedPersistentRuns.has(runId)
        ? [{ runId, at: Date.now(), kind: 'truncated' as const, text: 'output incomplete (durable capture was temporarily unavailable)' }]
        : []
      const after = this.#pendingGapAfter.has(runId)
        ? [{ runId, at: Date.now(), kind: 'truncated' as const, text: 'output incomplete (durable capture was temporarily unavailable)' }]
        : []
      // Consume only this batch's markers; output may overflow again while the write awaits.
      this.#failedPersistentRuns.delete(runId)
      this.#pendingGapAfter.delete(runId)
      try {
        await this.#persist([...before, ...chunks, ...after])
      } catch (error) {
        // Never retry unknown body writes. A later batch starts with a durable gap marker.
        this.#rememberFailure(runId, error)
      }
    }
  }

  #rememberFailure(runId: string, error: unknown): void {
    this.#failedPersistentRuns.delete(runId)
    this.#failedPersistentRuns.add(runId)
    this.#persistenceErrors.set(runId, error instanceof Error ? error : new Error(String(error)))
    while (this.#failedPersistentRuns.size > 512) {
      const oldest = this.#failedPersistentRuns.values().next().value
      if (typeof oldest !== 'string') break
      this.#failedPersistentRuns.delete(oldest)
      this.#persistenceErrors.delete(oldest)
    }
  }
}
