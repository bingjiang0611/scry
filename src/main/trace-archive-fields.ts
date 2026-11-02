import { providerIdForRuntime, type RuntimeProvider } from '../shared/runtime'
import type { ArchiveBodyFacts, ArchiveTurnExpectation } from './trace-archive-projection'

/**
 * Field selection for the archive projection: which stored fields may stand for
 * recorded text, and which identity claims must hold before a file is trusted.
 *
 * These rules live beside the projection but away from its token loop so that
 * "what counts as visible" stays readable in one place.
 */
export const BODY_KEYS = new Set(['source', 'encoding', 'sourceCompleteness', 'redaction', 'storage'])
export const REF_KEYS = new Set(['storage', 'sha256', 'bytes', 'encoding'])

/** Only visible assistant text is projected; reasoning, tools and subagents are not. */
export function keepText(meta: Map<string, unknown>): boolean {
  return meta.get('kind') === 'model' && (meta.get('stage') === 'text' || meta.get('stage') === 'text_delta') &&
    meta.get('agentId') == null && meta.get('parentToolUseId') == null
}

export function assertProvider(expectation: ArchiveTurnExpectation, raw: { providerId?: unknown; runtimeProvider?: unknown }): void {
  if (raw.providerId !== undefined && raw.providerId !== expectation.providerId) {
    throw new Error('trace archive belongs to another Provider')
  }
  if (raw.runtimeProvider !== undefined &&
    providerIdForRuntime(raw.runtimeProvider as RuntimeProvider) !== expectation.providerId) {
    throw new Error('trace archive runtime belongs to another Provider')
  }
}

/** Keeps only the provenance fields that were actually present. */
export function factsOf(fields: Map<string, unknown>): ArchiveBodyFacts {
  const facts: ArchiveBodyFacts = {}
  for (const key of BODY_KEYS) if (typeof fields.get(key) === 'string') facts[key as 'source'] = fields.get(key) as string
  const ref = fields.get('contentRef')
  if (ref instanceof Map && ref.size > 0) {
    const contentRef: NonNullable<ArchiveBodyFacts['contentRef']> = {}
    if (typeof ref.get('storage') === 'string') contentRef.storage = ref.get('storage') as string
    if (typeof ref.get('sha256') === 'string') contentRef.sha256 = ref.get('sha256') as string
    if (typeof ref.get('encoding') === 'string') contentRef.encoding = ref.get('encoding') as string
    if (typeof ref.get('bytes') === 'number') contentRef.bytes = ref.get('bytes') as number
    facts.contentRef = contentRef
  }
  return facts
}

export function parseScalar(raw: string, kind: 'string' | 'number' | undefined): unknown {
  if (kind === 'string') return raw
  if (kind === 'number') return raw === '' ? undefined : Number(raw)
  return JSON.parse(raw) as unknown
}

export function assertArchiveIdentity(rootValues: Map<string, unknown>, expectation: ArchiveTurnExpectation): void {
  if (rootValues.get('version') !== 3) throw new Error('trace archive schema is invalid')
  if (rootValues.get('cwd') !== expectation.cwd) throw new Error('trace archive belongs to another workspace')
  const sessionId = rootValues.get('sessionId')
  const external = rootValues.get('externalSessionId')
  if (sessionId !== expectation.sessionId && external !== expectation.sessionId) {
    throw new Error('trace archive belongs to another session')
  }
  assertProvider(expectation, { providerId: rootValues.get('providerId'), runtimeProvider: rootValues.get('runtimeProvider') })
}

/** A primitive token value, or undefined for the structural tokens around it. */
export function primitiveValue(token: { name: string; value?: unknown }): unknown {
  if (token.name === 'trueValue') return true
  if (token.name === 'falseValue') return false
  if (token.name === 'nullValue') return null
  return token.value
}
