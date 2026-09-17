import { StringDecoder } from 'node:string_decoder'
import type { TraceEvent } from '../../shared/trace.js'
import { isToolContent, type ToolContent, type ToolContentReason, type ToolContentRef } from '../../shared/tool-content.js'
import type { RecorderConfig } from './config.js'

export type ToolContentPolicy = Pick<RecorderConfig['capture'], 'toolOutput' | 'toolContentFieldBytes' | 'toolContentTurnBytes'>
const MASK = '[REDACTED]'
const sensitiveKey = /password|passwd|pwd|token|secret|authorization|cookie|api[-_]?key|private[-_]?key|credential/i
const assignmentKey = '(?:[\\w.-]*(?:password|passwd|pwd|token|secret|authorization|cookie|api[_-]?key|credential)[\\w.-]*)'

// Known-pattern redaction, not a guarantee that arbitrary free text contains no unknown secrets.
// Inspect the whole value BEFORE taking a byte prefix, including secrets beyond the summary boundary.
export function redactToolText(value: string): string {
  // Decode form keys before matching; percent-encoded sensitive names are not a bypass.
  if (/^[^\s=&]+=[^\r\n]*(?:&[^\s=&]+=[^\r\n]*)*$/.test(value)) {
    const form = new URLSearchParams(value)
    let changed = false
    for (const key of [...form.keys()]) {
      if (sensitiveKey.test(key)) { form.set(key, MASK); changed = true }
    }
    if (changed) value = form.toString()
  }
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, MASK)
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(/([?&][^\s=&#]+)=([^\s&#"'<>]*)/g, `$1=${MASK}`)
    .replace(/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, `$1: ${MASK}`)
    .replace(new RegExp(`(["']?${assignmentKey}["']?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;&}]+)`, 'gi'), `$1"${MASK}"`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, `$1 ${MASK}`)
}

function redactValue(value: unknown, seen: Set<object>, depth: number, state: { changed: boolean }): unknown {
  if (depth > 64) throw new Error('depth')
  if (typeof value === 'string') {
    // Structured strings retain nested sensitive-key semantics, including form-like tool responses.
    if (/^\s*[\[{]/.test(value)) {
      let parsed: unknown
      try { parsed = JSON.parse(value) } catch {
        const safe = redactToolText(value)
        state.changed ||= safe !== value
        return safe
      }
      return JSON.stringify(redactValue(parsed, seen, depth + 1, state))
    }
    const safe = redactToolText(value)
    state.changed ||= safe !== value
    return safe
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('serialization')
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('unsupported object')
  seen.add(value)
  try {
    const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null) as Record<string, unknown>
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue
      // Do not invoke getters or toJSON on an untrusted tool payload.
      if (!('value' in descriptor)) throw new Error('accessor')
      const sensitive = sensitiveKey.test(key)
      state.changed ||= sensitive && descriptor.value !== MASK
      const safe = sensitive ? MASK : redactValue(descriptor.value, seen, depth + 1, state)
      Object.defineProperty(out, key, { value: safe, enumerable: true, writable: true, configurable: true })
    }
    return out
  } finally {
    seen.delete(value)
  }
}

export function limitToolContent(field: ToolContent, bytes: number, reason: 'field_budget' | 'turn_budget'): ToolContent {
  if (field.content === undefined || field.savedBytes <= bytes) return field
  const content = new StringDecoder('utf8').write(Buffer.from(field.content).subarray(0, Math.max(0, bytes)))
  const { content: _content, ...metadata } = field
  return {
    ...metadata,
    ...(content ? { content } : {}),
    savedBytes: Buffer.byteLength(content),
    encoding: field.encoding === 'json' ? 'json-fragment' : field.encoding,
    storage: content ? 'truncated' : 'omitted',
    reasons: [...new Set([...field.reasons, reason])]
  }
}

export function captureToolContent(value: unknown, options: {
  source: string
  maxBytes?: number | null
  sourceCompleteness?: ToolContent['sourceCompleteness']
  reasons?: ToolContentReason[]
}): ToolContent {
  const base: ToolContent = {
    encoding: typeof value === 'string' ? 'utf8' : 'json', savedBytes: 0,
    source: options.source, sourceCompleteness: value === undefined && options.sourceCompleteness !== 'partial' ? 'unavailable' : options.sourceCompleteness ?? 'unknown',
    redaction: 'not_run', storage: 'omitted', reasons: options.reasons ?? []
  }
  if (value === undefined) return { ...base, reasons: [...new Set([...base.reasons, 'provider_missing' as const])] }
  try {
    const state = { changed: false }
    const safe = redactValue(value, new Set(), 0, state)
    const content = typeof safe === 'string' ? safe : JSON.stringify(safe)
    // Only serialize the inspected clone, never invoke the original object's toJSON.
    const captured: ToolContent = {
      ...base, content, savedBytes: Buffer.byteLength(content),
      redaction: state.changed ? 'applied' : 'unchanged', storage: 'complete'
    }
    return options.maxBytes === null
      ? captured
      : limitToolContent(captured, options.maxBytes ?? 8 * 1024, 'field_budget')
  } catch {
    return { ...base, redaction: 'failed', reasons: [...new Set([...base.reasons, 'redaction_failed' as const])] }
  }
}

export function sanitizeCapturedContent(field: ToolContent, maxBytes?: number | null): ToolContent {
  if (!isToolContent(field)) return { ...captureToolContent(undefined, { source: 'invalid_content' }), redaction: 'failed', reasons: ['redaction_failed'] }
  if (field.content === undefined) return field
  const checked = captureToolContent(field.content, { source: field.source, maxBytes })
  const { content: _content, ...metadata } = field
  return {
    ...metadata,
    ...(checked.content !== undefined ? { content: checked.content } : {}),
    savedBytes: checked.savedBytes,
    encoding: field.encoding === 'json' && checked.storage !== 'complete' ? 'json-fragment' : field.encoding,
    storage: checked.storage === 'complete' ? field.storage : checked.storage,
    redaction: checked.redaction === 'unchanged' ? field.redaction : checked.redaction,
    reasons: [...new Set([...field.reasons, ...checked.reasons])]
  }
}

function sourceState(event: TraceEvent, input: boolean): Pick<ToolContent, 'sourceCompleteness' | 'reasons'> {
  const limitations = event.runtimeMetadata?.scryCaptureLimitations
  const limited = Array.isArray(limitations) && limitations.some((raw) => raw && typeof raw === 'object' &&
    (raw as Record<string, unknown>).field === (input ? 'tool_input' : 'tool_response'))
  return limited ? { sourceCompleteness: 'partial', reasons: ['source_truncated'] } : { sourceCompleteness: 'unknown', reasons: [] }
}

function protectedToolEvent(event: TraceEvent, content: ToolContent, result: boolean): TraceEvent {
  const { input: _input, output: _output, text: _text, inputContent: _ic, outputContent: _oc, ...metadata } = event
  // Task descriptions and MCP names can be derived from tool input, not just static labels.
  metadata.stage = redactToolText(metadata.stage)
  if (metadata.name) metadata.name = redactToolText(metadata.name)
  if (metadata.tool) metadata.tool = redactToolText(metadata.tool)
  if (metadata.danger) metadata.danger = { ...metadata.danger, reason: redactToolText(metadata.danger.reason) }
  for (const key of ['mcpServer', 'mcpAction', 'mcpTool'] as const) {
    if (metadata[key]) metadata[key] = redactToolText(metadata[key])
  }
  if (metadata.mcpCalls) metadata.mcpCalls = metadata.mcpCalls.map((call) => ({
    server: redactToolText(call.server), action: redactToolText(call.action), tool: redactToolText(call.tool)
  }))
  return result
    ? { ...metadata, outputContent: content, ...(content.content !== undefined ? { output: content.content, text: content.content } : {}) }
    : { ...metadata, inputContent: content, ...(content.content !== undefined ? { input: content.encoding === 'json' ? JSON.parse(content.content) as unknown : content.content } : {}) }
}

export function sanitizeToolEvents(events: TraceEvent[], policy: ToolContentPolicy, source: string): TraceEvent[] {
  if (policy.toolOutput !== 'full-redacted') return events
  return events.map((event) => {
    if (!['tool', 'skill', 'agent'].includes(event.kind)) return event
    const result = event.stage === 'tool_result'
    const existing = result ? event.outputContent : event.inputContent
    const raw = result ? event.output ?? event.text : event.input
    // Internally persisted envelopes survive replay. Re-inspect content; never trust a redaction flag alone.
    const content = existing ? sanitizeCapturedContent(existing, policy.toolContentFieldBytes) : captureToolContent(raw, {
      source, maxBytes: policy.toolContentFieldBytes, ...sourceState(event, !result)
    })
    return protectedToolEvent(event, content, result)
  })
}

/** Persist complete redacted bodies before applying the bounded inline projection. */
export async function persistToolEventContent(
  events: TraceEvent[],
  policy: ToolContentPolicy,
  source: string,
  persist: (content: string, encoding: ToolContentRef['encoding']) => Promise<ToolContentRef>
): Promise<TraceEvent[]> {
  if (policy.toolOutput !== 'full-redacted') return events
  return Promise.all(events.map(async (event) => {
    if (!['tool', 'skill', 'agent'].includes(event.kind)) return event
    const result = event.stage === 'tool_result'
    const existing = result ? event.outputContent : event.inputContent
    const raw = result ? event.output ?? event.text : event.input
    let content: ToolContent
    if (existing?.contentRef) {
      content = sanitizeCapturedContent(existing, policy.toolContentFieldBytes)
    } else {
      const full = raw !== undefined
        ? captureToolContent(raw, { source, maxBytes: null, ...sourceState(event, !result) })
        : existing
          ? sanitizeCapturedContent(existing, null)
          : captureToolContent(undefined, { source })
      if (full.content !== undefined) {
        // Every body needs a durable copy: even a field below its own limit can be clipped later
        // when the shared turn budget is exhausted by earlier calls.
        const contentRef = await persist(full.content, full.encoding === 'json' ? 'json' : 'utf8')
        content = {
          ...(full.savedBytes > (policy.toolContentFieldBytes ?? 8 * 1024)
            ? limitToolContent(full, policy.toolContentFieldBytes ?? 8 * 1024, 'field_budget')
            : full),
          contentRef
        }
      } else {
        content = full
      }
    }
    return protectedToolEvent(event, content, result)
  }))
}
