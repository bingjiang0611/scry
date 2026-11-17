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
  const { content: _content, ...metadata } = field
  if (field.encoding === 'json') {
    // A byte cut of JSON text is not JSON. Bound the value structure instead, so what is kept can
    // still be parsed and every removed field states the size of what it replaced.
    const bounded = bytes > 0 ? limitJsonContent(field.content, bytes) : undefined
    if (bounded === undefined) {
      return {
        ...metadata,
        encoding: 'json-fragment',
        savedBytes: 0,
        storage: 'omitted',
        reasons: [...new Set([...field.reasons, reason])]
      }
    }
    return {
      ...metadata,
      content: bounded,
      savedBytes: Buffer.byteLength(bounded),
      encoding: 'json',
      storage: 'truncated',
      reasons: [...new Set([...field.reasons, reason])]
    }
  }
  const content = bytes > 0
    ? new StringDecoder('utf8').write(Buffer.from(field.content).subarray(0, bytes))
    : ''
  return {
    ...metadata,
    ...(content ? { content } : {}),
    savedBytes: Buffer.byteLength(content),
    storage: content ? 'truncated' : 'omitted',
    reasons: [...new Set([...field.reasons, reason])]
  }
}

/**
 * Stand-in for one JSON value the budget could not keep.
 *
 * It is the same vocabulary the surrounding envelope uses (`storage`), so a reader that already
 * understands a bounded body sees this loss the same way, and `originalBytes` says how much content
 * the marker replaced instead of leaving the reader to guess.
 */
export interface TruncatedJsonValue {
  storage: 'truncated'
  /** Bytes the replaced value serialized to. */
  originalBytes: number
  /** UTF-8 prefix of a replaced string, so the reader still sees what the field held. */
  preview?: string
}

function utf8Prefix(text: string, bytes: number): string {
  if (bytes <= 0) return ''
  return new StringDecoder('utf8').write(Buffer.from(text).subarray(0, bytes))
}

function truncatedJsonValue(value: unknown, previewBytes: number): TruncatedJsonValue {
  // The length a reader cares about is the field's own content, not the JSON quotes around it.
  const originalBytes = typeof value === 'string'
    ? Buffer.byteLength(value)
    : value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value) ?? '')
  const preview = typeof value === 'string' ? utf8Prefix(value, previewBytes) : ''
  return preview ? { storage: 'truncated', originalBytes, preview } : { storage: 'truncated', originalBytes }
}

/** Replace every string longer than `cap` bytes with a marker that states its original length. */
function truncateJsonStrings(value: unknown, cap: number): unknown {
  if (typeof value === 'string') return Buffer.byteLength(value) > cap ? truncatedJsonValue(value, cap) : value
  if (Array.isArray(value)) return value.map((item) => truncateJsonStrings(item, cap))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = truncateJsonStrings(item, cap)
    return out
  }
  return value
}

/**
 * The largest form of `content` that fits `bytes` and is still JSON.
 *
 * Long strings keep a readable prefix; when the structure alone cannot fit (a body of thousands of
 * small values), one marker states the original size rather than shipping an unparseable cut.
 * Returns undefined when even that marker does not fit: there is nothing honest to keep.
 */
function limitJsonContent(content: string, bytes: number): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  for (let cap = bytes; cap > 0; cap = Math.floor(cap / 2)) {
    const candidate = JSON.stringify(truncateJsonStrings(parsed, cap))
    if (Buffer.byteLength(candidate) <= bytes) return candidate
  }
  const marker = JSON.stringify({ storage: 'truncated', originalBytes: Buffer.byteLength(content) })
  return Buffer.byteLength(marker) <= bytes ? marker : undefined
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
  // A JSON body is re-bounded structurally: cutting its text would leave something that no longer
  // parses while still claiming to be JSON. Legacy fragments keep that label honestly.
  if (field.encoding === 'json' && isJsonText(field.content)) {
    return maxBytes == null || field.savedBytes <= maxBytes
      ? field
      : limitToolContent(field, maxBytes, 'field_budget')
  }
  const checked = captureToolContent(field.content, { source: field.source, maxBytes })
  const { content: _content, ...metadata } = field
  return {
    ...metadata,
    ...(checked.content !== undefined ? { content: checked.content } : {}),
    savedBytes: checked.savedBytes,
    encoding: field.encoding === 'json' ? 'json-fragment' : field.encoding,
    storage: checked.storage === 'complete' ? field.storage : checked.storage,
    // Preserve historical provenance: already-redacted bytes cannot be recovered by disabling redaction.
    redaction: field.redaction,
    reasons: [...new Set([...field.reasons, ...checked.reasons])]
  }
}

function isJsonText(content: string): boolean {
  try {
    JSON.parse(content)
    return true
  } catch {
    return false
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

export function toolContentTurnBudget(policy: ToolContentPolicy): number {
  return policy.toolContentTurnBytes ?? 128 * 1024
}

/**
 * One event of the turn projection: the same capture/limit/provenance rules the array form
 * applies, with the turn budget as an argument so a caller holding a cached prefix can resume
 * at any index. Returns the projected event and the budget left for the events after it.
 */
export function sanitizeToolEvent(
  event: TraceEvent,
  policy: ToolContentPolicy,
  source: string,
  remaining: number
): { event: TraceEvent; remaining: number } {
  if (!['tool', 'skill', 'agent'].includes(event.kind)) return { event, remaining }
  const result = event.stage === 'tool_result'
  const existing = result ? event.outputContent : event.inputContent
  const raw = result ? event.output ?? event.text : event.input
  // Persisted envelopes keep their provenance and byte bounds across replay.
  const captured = existing ? sanitizeCapturedContent(existing, policy.toolContentFieldBytes) : captureToolContent(raw, {
    source, maxBytes: policy.toolContentFieldBytes, ...sourceState(event, !result)
  })
  const content = limitToolContent(captured, Math.max(0, remaining), 'turn_budget')
  return { event: protectedToolEvent(event, content, result), remaining: remaining - content.savedBytes }
}

export function sanitizeToolEvents(events: TraceEvent[], policy: ToolContentPolicy, source: string): TraceEvent[] {
  if (!isFullToolContentPolicy(policy)) return events
  // The turn budget is declared on the policy, so a whole turn must be bounded,
  // not just each field: a long run can otherwise retain thousands of 8 KiB
  // bodies and overflow a single evidence payload. Later bodies keep their
  // metadata (including any durable reference) and report turn_budget honestly.
  let remaining = toolContentTurnBudget(policy)
  return events.map((event) => {
    const step = sanitizeToolEvent(event, policy, source, remaining)
    remaining = step.remaining
    return step.event
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

export type ToolContentFieldSide = 'input' | 'output'

async function persistEventField(
  event: TraceEvent,
  field: ToolContentFieldSide,
  policy: ToolContentPolicy,
  source: string,
  persist: (content: string, encoding: ToolContentRef['encoding'], field: ToolContentFieldSide) => Promise<ToolContentRef>
): Promise<ToolContent> {
  const existing = field === 'output' ? event.outputContent : event.inputContent
  const raw = field === 'output' ? event.output ?? event.text : event.input
  if (existing?.contentRef) return sanitizeCapturedContent(existing, policy.toolContentFieldBytes)
  // Aliases on an already captured event are previews, not a new raw source.
  const full = existing
    ? sanitizeCapturedContent(existing, null)
    : captureToolContent(raw, { source, maxBytes: null, ...sourceState(event, field === 'input') })
  if (full.content === undefined || full.storage !== 'complete') {
    return sanitizeCapturedContent(full, policy.toolContentFieldBytes)
  }
  // Every body needs a durable copy: even a field below its own limit can be clipped later when the
  // shared turn budget is exhausted by earlier calls.
  const contentRef = await persist(full.content, full.encoding === 'json' ? 'json' : 'utf8', field)
  return {
    ...(full.savedBytes > (policy.toolContentFieldBytes ?? 8 * 1024)
      ? limitToolContent(full, policy.toolContentFieldBytes ?? 8 * 1024, 'field_budget')
      : full),
    contentRef
  }
}

/** Persist complete raw bodies before applying the bounded inline projection. */
export async function persistToolEventContent(
  events: TraceEvent[],
  policy: ToolContentPolicy,
  source: string,
  persist: (content: string, encoding: ToolContentRef['encoding'], field: ToolContentFieldSide) => Promise<ToolContentRef>
): Promise<TraceEvent[]> {
  if (!isFullToolContentPolicy(policy)) return events
  return Promise.all(events.map(async (event) => {
    if (!['tool', 'skill', 'agent'].includes(event.kind)) return event
    const result = event.stage === 'tool_result'
    const primary = await persistEventField(event, result ? 'output' : 'input', policy, source, persist)
    const projected = protectedToolEvent(event, primary, result)
    // 入参与输出按字段区分，不按事件类型：tool_result 也可能带工具入参正文，入参一侧同样要有可读字节，
    // 否则采集策略裁剪掉输出后，这一轮的工具入参就没有任何副本可读。
    if (!result || (event.input === undefined && event.inputContent === undefined)) return projected
    return { ...projected, inputContent: await persistEventField(event, 'input', policy, source, persist) }
  }))
}
