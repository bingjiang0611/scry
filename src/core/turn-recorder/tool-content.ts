import { StringDecoder } from 'node:string_decoder'
import type { TraceEvent } from '../../shared/trace.js'
import { isToolContent, type ToolContent, type ToolContentReason, type ToolContentRef } from '../../shared/tool-content.js'
import type { RecorderConfig } from './config.js'

export type ToolContentPolicy = Pick<RecorderConfig['capture'], 'toolContentFieldBytes' | 'toolContentTurnBytes'> & {
  // The legacy name can still occur in persisted retry artifacts. It no longer enables redaction.
  toolOutput: RecorderConfig['capture']['toolOutput'] | 'full-redacted'
}

export function isFullToolContentPolicy(policy: ToolContentPolicy | undefined): policy is ToolContentPolicy {
  return policy?.toolOutput === 'full' || policy?.toolOutput === 'full-redacted'
}

function serializableValue(value: unknown, seen: Set<object>, depth: number): unknown {
  if (depth > 64) throw new Error('depth')
  if (typeof value === 'string') return value
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
      const safe = serializableValue(descriptor.value, seen, depth + 1)
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
    redaction: 'disabled', storage: 'omitted', reasons: options.reasons ?? []
  }
  if (value === undefined) return { ...base, reasons: [...new Set([...base.reasons, 'provider_missing' as const])] }
  try {
    const safe = serializableValue(value, new Set(), 0)
    const content = typeof safe === 'string' ? safe : JSON.stringify(safe)
    // Only serialize the inspected clone, never invoke the original object's toJSON.
    const captured: ToolContent = {
      ...base, content, savedBytes: Buffer.byteLength(content),
      storage: 'complete'
    }
    return options.maxBytes === null
      ? captured
      : limitToolContent(captured, options.maxBytes ?? 8 * 1024, 'field_budget')
  } catch {
    return { ...base, reasons: [...new Set([...base.reasons, 'serialization_failed' as const])] }
  }
}

export function sanitizeCapturedContent(field: ToolContent, maxBytes?: number | null): ToolContent {
  if (!isToolContent(field)) return { ...captureToolContent(undefined, { source: 'invalid_content' }), reasons: ['serialization_failed'] }
  if (field.content === undefined) return field
  const checked = captureToolContent(field.content, { source: field.source, maxBytes })
  const { content: _content, ...metadata } = field
  return {
    ...metadata,
    ...(checked.content !== undefined ? { content: checked.content } : {}),
    savedBytes: checked.savedBytes,
    encoding: field.encoding === 'json' && checked.storage !== 'complete' ? 'json-fragment' : field.encoding,
    storage: checked.storage === 'complete' ? field.storage : checked.storage,
    // Preserve historical provenance: already-redacted bytes cannot be recovered by disabling redaction.
    redaction: field.redaction,
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
  return result
    ? { ...metadata, outputContent: content, ...(content.content !== undefined ? { output: content.content, text: content.content } : {}) }
    : { ...metadata, inputContent: content, ...(content.content !== undefined ? { input: content.encoding === 'json' ? JSON.parse(content.content) as unknown : content.content } : {}) }
}

export function sanitizeToolEvents(events: TraceEvent[], policy: ToolContentPolicy, source: string): TraceEvent[] {
  if (!isFullToolContentPolicy(policy)) return events
  // The turn budget is declared on the policy, so a whole turn must be bounded,
  // not just each field: a long run can otherwise retain thousands of 8 KiB
  // bodies and overflow a single evidence payload. Later bodies keep their
  // metadata (including any durable reference) and report turn_budget honestly.
  let remaining = policy.toolContentTurnBytes ?? 128 * 1024
  return events.map((event) => {
    if (!['tool', 'skill', 'agent'].includes(event.kind)) return event
    const result = event.stage === 'tool_result'
    const existing = result ? event.outputContent : event.inputContent
    const raw = result ? event.output ?? event.text : event.input
    // Persisted envelopes keep their provenance and byte bounds across replay.
    const captured = existing ? sanitizeCapturedContent(existing, policy.toolContentFieldBytes) : captureToolContent(raw, {
      source, maxBytes: policy.toolContentFieldBytes, ...sourceState(event, !result)
    })
    const content = limitToolContent(captured, Math.max(0, remaining), 'turn_budget')
    remaining -= content.savedBytes
    return protectedToolEvent(event, content, result)
  })
}

interface ModelEventBody {
  events: TraceEvent[]
  /** Absent for non-model events, empty bodies, or references that have not been hydrated. */
  body?: { kind: 'text' | 'thinking'; text: string }
}

function modelRunBody(run: TraceEvent[]): ModelEventBody {
  if (run.some((event) => event.modelContent?.contentRef)) return { events: run }
  const thinking = run[0].stage === 'thinking'
  const deltas = thinking ? '' : run.filter((event) => event.stage === 'text_delta').map((event) => event.text ?? '').join('')
  const authoritative = thinking ? undefined : [...run].reverse().find((event) =>
    event.stage === 'text' && event.runtimeMetadata?.replacesStreamedText === true
  )
  const text = thinking
    ? run.map((event) => event.thinking ?? '').join('')
    : authoritative?.text ?? run.map((event) => event.stage === 'text' && deltas && event.text === deltas ? '' : event.text ?? '').join('')
  if (!text) return { events: run }
  return { events: run, body: { kind: thinking ? 'thinking' : 'text', text } }
}

/** Shared, read-only projection. Callers must hydrate references before treating previews as bodies. */
export function* modelEventBodies(events: readonly TraceEvent[]): Generator<ModelEventBody> {
  let run: TraceEvent[] = []
  let runKey: string | undefined
  for (const event of events) {
    const bodyKind = event.kind === 'model' && event.stage === 'thinking' && event.thinking != null
      ? 'thinking'
      : event.kind === 'model' && ['text', 'text_delta'].includes(event.stage) && event.text != null
        ? 'text'
        : undefined
    if (!bodyKind) {
      if (run.length) yield modelRunBody(run)
      run = []
      runKey = undefined
      yield { events: [event] }
      continue
    }
    const key = JSON.stringify([
      bodyKind, event.messageId ?? null, event.runtimeMetadata?.codexItemId ?? null,
      event.agentId ?? null, event.parentToolUseId ?? null
    ])
    if (runKey !== undefined && runKey !== key) {
      yield modelRunBody(run)
      run = []
    }
    runKey = key
    run.push(event)
  }
  if (run.length) yield modelRunBody(run)
}

/** Persist coalesced assistant/reasoning bodies before applying a bounded record projection. */
export async function persistModelEventContent(
  events: TraceEvent[],
  source: string,
  persist: (content: string, encoding: ToolContentRef['encoding']) => Promise<ToolContentRef>,
  previewBytes = 32 * 1024
): Promise<TraceEvent[]> {
  const output: TraceEvent[] = []
  for (const group of modelEventBodies(events)) {
    if (!group.body) {
      output.push(...group.events)
      continue
    }
    const full = captureToolContent(group.body.text, { source, maxBytes: null, sourceCompleteness: 'complete' })
    if (full.content === undefined) {
      output.push(...group.events)
      continue
    }
    const contentRef = await persist(full.content, 'utf8')
    const modelContent = { ...limitToolContent(full, previewBytes, 'field_budget'), contentRef }
    const { text: _text, thinking: _thinking, modelContent: _content, ...metadata } = group.events[0]
    output.push({
      ...metadata,
      stage: group.body.kind,
      ...(group.body.kind === 'thinking' ? { thinking: modelContent.content } : { text: modelContent.content }),
      modelContent
    })
  }
  return output
}

/** Persist complete raw bodies before applying the bounded inline projection. */
export async function persistToolEventContent(
  events: TraceEvent[],
  policy: ToolContentPolicy,
  source: string,
  persist: (content: string, encoding: ToolContentRef['encoding']) => Promise<ToolContentRef>
): Promise<TraceEvent[]> {
  if (!isFullToolContentPolicy(policy)) return events
  return Promise.all(events.map(async (event) => {
    if (!['tool', 'skill', 'agent'].includes(event.kind)) return event
    const result = event.stage === 'tool_result'
    const existing = result ? event.outputContent : event.inputContent
    const raw = result ? event.output ?? event.text : event.input
    let content: ToolContent
    if (existing?.contentRef) {
      content = sanitizeCapturedContent(existing, policy.toolContentFieldBytes)
    } else {
      // Aliases on an already captured event are previews, not a new raw source.
      const full = existing
        ? sanitizeCapturedContent(existing, null)
        : captureToolContent(raw, { source, maxBytes: null, ...sourceState(event, !result) })
      if (full.content !== undefined && full.storage === 'complete') {
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
        content = sanitizeCapturedContent(full, policy.toolContentFieldBytes)
      }
    }
    return protectedToolEvent(event, content, result)
  }))
}
