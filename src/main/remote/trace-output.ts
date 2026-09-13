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
  if (ev.stage === 'text' && typeof ev.text === 'string' && ev.text.length > 0) {
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

// Flatten one turn's trace events into the ordered content chunks the phone
// renders. Applies the SAME result-text fallback the live binding uses: some
// Providers only deliver the final answer on the terminal result event (never as
// a streamed stage:'text'), so when a turn produced no streamed text we surface
// the non-error result text as the reply - otherwise the turn would show tools
// but no answer. A Provider that streamed text is never double-emitted.
export function flattenTraceItems(items: readonly TraceEvent[]): RemoteOutputChunk[] {
  const out: RemoteOutputChunk[] = []
  let sawText = false
  for (const ev of items) {
    const chunk = traceEventToOutputChunk(ev)
    if (chunk) {
      if (chunk.kind === 'output') sawText = true
      out.push(chunk)
      continue
    }
    if (ev.kind === 'harness' && ev.stage === 'result' && !ev.isError && !sawText && typeof ev.text === 'string' && ev.text.length > 0) {
      sawText = true
      out.push({ kind: 'output', text: ev.text })
    }
  }
  return out
}
