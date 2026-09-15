import { maskSecrets } from '../../shared/trace'

// Per-run, in-memory, cursor-based OUTPUT log: the assistant's real trace
// CONTENT (text, reasoning, tool activity), streamed to an authorized device so
// the phone renders the actual run output rather than only the ledger lifecycle.
//
// Provenance & honesty (CLAUDE.md):
//   - This is the transcript/trace SHADOW *content*, distinct from the durable
//     ledger (lifecycle-only, non-secret markers) and from canonical usage. It
//     carries NO token/cost totals and must never be double-counted as usage;
//     the ledger `result` marker remains the authority for exact usage.
//   - Content is secret-masked before it is stored (same policy as the local DB
//     persistence path) and every chunk is byte-bounded.
//   - It is a LIVE cache, not a complete audit log: it is in-memory (empty after
//     a host restart) and bounded per run and across runs. When a bound is hit
//     it appends ONE truthful `truncated` marker instead of silently dropping
//     content as if the output were complete. A device polling an evicted run
//     gets an empty page, which the UI must present as "output not cached", not
//     as "no output".
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

// Bounds: a single pathological run cannot exhaust host memory, and a device
// poll frame stays small. Generous enough for a real turn's visible output.
const MAX_CHUNK_BYTES = 16 * 1024
const MAX_BYTES_PER_RUN = 1_000_000
const MAX_EVENTS_PER_RUN = 4_000
const DEFAULT_PAGE = 200
const MAX_RUNS = 256

interface RunBuffer {
  seq: number
  bytes: number
  chunks: OutputChunk[]
  truncated: boolean
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

function splitUtf8(text: string, maxBytes: number): string[] {
  if (byteLength(text) <= maxBytes) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining) {
    const bytes = Buffer.from(remaining, 'utf8')
    const chunk = bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '')
    if (!chunk) break
    chunks.push(chunk)
    remaining = remaining.slice(chunk.length)
  }
  return chunks
}

export class RunOutputLog {
  // Insertion-ordered so the oldest run is evicted first when MAX_RUNS is hit.
  #runs = new Map<string, RunBuffer>()

  // Append one content chunk for a run. Best-effort and never throws to the
  // caller: a run's execution must not fail because output could not be cached.
  append(runId: string, chunk: { kind: OutputChunkKind; text: string }): void {
    if (typeof runId !== 'string' || runId.length === 0 || runId.length > 128) return
    const text = maskSecrets(typeof chunk.text === 'string' ? chunk.text : '') ?? ''
    if (text.length === 0 && chunk.kind !== 'truncated') return
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
  since(runId: string, cursor: number, pageSize = DEFAULT_PAGE): RunOutputPage {
    const start = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
    const buffer = this.#runs.get(runId)
    if (!buffer) return { chunks: [], cursor: start }
    const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, DEFAULT_PAGE) : DEFAULT_PAGE
    const chunks = buffer.chunks.filter((c) => c.seq > start).slice(0, size)
    const next = chunks.length > 0 ? chunks[chunks.length - 1].seq : start
    return { chunks: chunks.map((c) => ({ ...c })), cursor: next }
  }
}
