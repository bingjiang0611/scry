import { createHash } from 'node:crypto'
import { MAX_PAYLOAD_BYTES, OrchestrationStoreError } from './types'

function normalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : normalizeValue(item)))
  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    const entry = record[key]
    if (entry !== undefined) sorted[key] = normalizeValue(entry)
  }
  return sorted
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value))
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export function truncatePreview(text: string | undefined | null, maxChars: number): string | null {
  if (typeof text !== 'string') return null
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

export function assertBoundedPayload(payload: unknown): string {
  const encoded = canonicalJson(payload)
  if (utf8ByteLength(encoded) > MAX_PAYLOAD_BYTES) {
    throw new OrchestrationStoreError(
      'orchestration_payload_too_large',
      `Orchestration payload exceeds ${MAX_PAYLOAD_BYTES} bytes`
    )
  }
  return encoded
}

const FORBIDDEN_USAGE_KEYS = new Set([
  'usage',
  'tokens',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'reasoningTokens',
  'totalTokens',
  'costUsd',
  'cost',
  'credits'
])

function containsForbiddenUsageKey(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = containsForbiddenUsageKey(item)
      if (hit) return hit
    }
    return null
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_USAGE_KEYS.has(key)) return key
    const hit = containsForbiddenUsageKey(entry)
    if (hit) return hit
  }
  return null
}

export function assertNoUsageNumbersInEvent(type: string, payload: unknown): void {
  const forbidden = containsForbiddenUsageKey(payload)
  if (forbidden) {
    throw new OrchestrationStoreError(
      'orchestration_usage_forbidden_in_event',
      `Usage field "${forbidden}" is forbidden in ${type} events (data §3.3)`
    )
  }
}
