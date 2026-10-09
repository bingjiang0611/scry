import type { TraceEvent } from '../../shared/trace'

// The device-facing content kinds. Mirrors what the run-output stream carries so
// a LIVE run and a REPLAYED history render identically on the phone.
export type RemoteOutputKind = 'output' | 'reasoning' | 'tool' | 'tool_result'

export interface RemoteOutputChunk {
  kind: RemoteOutputKind
  text: string
}

// Map a single REAL trace event to a device-facing content chunk, or null when
// the event carries no directly renderable content (lifecycle-only). This is the
// SINGLE source of truth shared by the live run binding and the history reader
// so the phone never sees two divergent renderings of the same provider output.
// It derives NOTHING it cannot read off the event; nothing is fabricated.
export function traceEventToOutputChunk(ev: TraceEvent): RemoteOutputChunk | null {
  // Modern streaming adapters (Codex, Pi, and Qoder) emit assistant content as
  // text_delta chunks. Treat both snapshot text and deltas as real output; the
  // adapters already suppress duplicate snapshot prefixes before emitting.
  if ((ev.stage === 'text' || ev.stage === 'text_delta') && typeof ev.text === 'string' && ev.text.length > 0) {
    return { kind: 'output', text: ev.text }
  }
  if (ev.stage === 'thinking' && typeof ev.thinking === 'string' && ev.thinking.length > 0) {
    return { kind: 'reasoning', text: ev.thinking }
  }
  if (ev.kind === 'tool' && ev.toolUseId && typeof ev.output === 'string' && ev.output.length > 0) {
    // A tool_result carries observable output text for its tool_use.
    return { kind: 'tool_result', text: ev.output }
  }
  if (ev.kind === 'tool' && ev.tool && ev.output === undefined) {
    // A tool_use: surface the tool name (+ a short input hint) as activity.
    const hint = ev.filePath ? ` ${ev.filePath}` : ''
    return { kind: 'tool', text: `${ev.tool}${hint}` }
  }
  return null
}

// Recent partial evidence only: cap projection work before merging token deltas.
// This does not hydrate external tool content or invent a tool result.
export function previewTraceItems(items: readonly TraceEvent[]): { items: (RemoteOutputChunk & { truncated: boolean })[]; truncated: boolean } {
  let truncated = items.length > 256
  const out: (RemoteOutputChunk & { truncated: boolean })[] = []
  const tail = (text: string): { text: string; truncated: boolean } => {
    if (text.length <= 2_048) return { text, truncated: false }
    let start = text.length - 2_048
    const code = text.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff) start++
    return { text: text.slice(start), truncated: true }
  }
  visitTraceChunks(items.slice(-256), (chunk, event) => {
    const bounded = tail(chunk.text)
    const content = chunk.kind === 'tool_result' ? event.outputContent :
      chunk.kind === 'output' || chunk.kind === 'reasoning' ? event.modelContent : undefined
    bounded.truncated ||= content?.storage === 'truncated' || content?.storage === 'omitted' || content?.sourceCompleteness === 'partial' || content?.contentRef !== undefined
    const previous = out[out.length - 1]
    if (previous && previous.kind === chunk.kind && (chunk.kind === 'output' || chunk.kind === 'reasoning')) {
      const merged = tail(previous.text + bounded.text)
      previous.text = merged.text
      previous.truncated ||= bounded.truncated || merged.truncated
      truncated ||= previous.truncated
    } else {
      out.push({ kind: chunk.kind, ...bounded })
      truncated ||= bounded.truncated
      if (out.length > 2) {
        out.shift()
        truncated = true
      }
    }
  })
  return { items: out, truncated }
}

// Flatten one turn's trace events into the ordered content chunks the phone
// renders. Applies the SAME result-text fallback the live binding uses: some
// Providers only deliver the final answer on the terminal result event (never as
// a streamed stage:'text'), so when a turn produced no streamed text we surface
// the non-error result text as the reply - otherwise the turn would show tools
// but no answer. A Provider that streamed text is never double-emitted.
export function flattenTraceItems(items: readonly TraceEvent[]): RemoteOutputChunk[] {
  const out: RemoteOutputChunk[] = []
  const append = (chunk: RemoteOutputChunk): void => {
    const previous = out[out.length - 1]
    // Archived streaming adapters often persist one text_delta per token. Merge
    // adjacent text/reasoning deltas into readable blocks while preserving the
    // exact bytes and keeping tool boundaries intact.
    if (previous && previous.kind === chunk.kind && (chunk.kind === 'output' || chunk.kind === 'reasoning')) {
      previous.text += chunk.text
    } else {
      out.push(chunk)
    }
  }
  visitTraceChunks(items, append)
  return out
}

function visitTraceChunks(items: readonly TraceEvent[], append: (chunk: RemoteOutputChunk, event: TraceEvent) => void): void {
  let sawText = false
  for (const ev of items) {
    const chunk = traceEventToOutputChunk(ev)
    if (chunk) {
      if (chunk.kind === 'output') sawText = true
      append(chunk, ev)
      continue
    }
    if (ev.kind === 'harness' && ev.stage === 'result' && !ev.isError && !sawText && typeof ev.text === 'string' && ev.text.length > 0) {
      sawText = true
      append({ kind: 'output', text: ev.text }, ev)
    }
  }
}
