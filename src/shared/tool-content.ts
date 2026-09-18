// Additive schema-v1 payload. Absence means a legacy writer, never proof of complete content.
export type ToolContentReason = 'provider_missing' | 'source_truncated' | 'field_budget' | 'turn_budget' | 'redaction_failed' | 'serialization_failed' | 'not_collected'

export interface ToolContentRef {
  storage: 'recorder-content-v1'
  sha256: string
  bytes: number
  encoding: 'utf8' | 'json'
}

/** Generic durable captured body reference; ToolContentRef remains the schema-v1 compatibility name. */
export type ContentRef = ToolContentRef

export interface RecorderContentPageRequest {
  ref: ContentRef
  offset?: number
  limit?: number
}

export interface RecorderContentPage {
  offset: number
  nextOffset: number
  totalBytes: number
  hasMore: boolean
  dataBase64: string
}

export interface ToolContent {
  content?: string
  /** Complete captured content stored outside the bounded inline preview; inspect redaction provenance. */
  contentRef?: ToolContentRef
  encoding: 'utf8' | 'json' | 'json-fragment'
  savedBytes: number
  source: string
  sourceCompleteness: 'unknown' | 'complete' | 'partial' | 'unavailable'
  redaction: 'applied' | 'unchanged' | 'failed' | 'not_run' | 'disabled'
  storage: 'complete' | 'truncated' | 'omitted'
  reasons: ToolContentReason[]
}

/** Generic captured body envelope; usable for tools, model output, diffs and transcript ranges. */
export type ContentEnvelope = ToolContent

export function isToolContentRef(value: unknown): value is ToolContentRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return raw.storage === 'recorder-content-v1' &&
    typeof raw.sha256 === 'string' && /^[a-f0-9]{64}$/.test(raw.sha256) &&
    Number.isSafeInteger(raw.bytes) && Number(raw.bytes) >= 0 &&
    (raw.encoding === 'utf8' || raw.encoding === 'json')
}

export function isToolContent(value: unknown): value is ToolContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (raw.content !== undefined && typeof raw.content !== 'string') return false
  if (raw.contentRef !== undefined && !isToolContentRef(raw.contentRef)) return false
  if (!['utf8', 'json', 'json-fragment'].includes(String(raw.encoding)) || typeof raw.source !== 'string') return false
  if (!['unknown', 'complete', 'partial', 'unavailable'].includes(String(raw.sourceCompleteness))) return false
  if (!['applied', 'unchanged', 'failed', 'not_run', 'disabled'].includes(String(raw.redaction))) return false
  if (!['complete', 'truncated', 'omitted'].includes(String(raw.storage))) return false
  if (!Array.isArray(raw.reasons) || !raw.reasons.every((reason) => ['provider_missing', 'source_truncated', 'field_budget', 'turn_budget', 'redaction_failed', 'serialization_failed', 'not_collected'].includes(String(reason)))) return false
  if (!Number.isSafeInteger(raw.savedBytes) || Number(raw.savedBytes) < 0) return false
  if (raw.savedBytes !== new TextEncoder().encode(typeof raw.content === 'string' ? raw.content : '').byteLength) return false
  if (raw.encoding === 'json' && typeof raw.content === 'string') {
    try { JSON.parse(raw.content) } catch { return false }
  }
  if (raw.redaction === 'failed' && (raw.storage !== 'omitted' || !raw.reasons.includes('redaction_failed'))) return false
  return raw.storage === 'omitted' ? raw.content === undefined : typeof raw.content === 'string'
}
