import { PROMPT_PREVIEW_MAX_CHARS, type TurnProjectionRow } from './types'
import type { Evidence } from '../../shared/turn-record-contracts'
import type { SessionCatalogMetadata, SubscribeRequest } from '../../shared/orchestration-subscribe'

const DEVICE_FIELDS = [
  'runId', 'sessionKey', 'nativeSessionId', 'provider', 'profile', 'cwd', 'title', 'ts',
  'pinnedAt', 'archivedAt', 'ordinal', 'ordinalOrigin', 'delivery', 'outputSeq', 'stopState',
  'settledAt', 'recoveredAt', 'questionId', 'kind', 'status'
]

export function visibleCatalog(
  catalog: SessionCatalogMetadata,
  canReadCwd: (cwd: string | null) => boolean
): SessionCatalogMetadata {
  const { projectCwd } = catalog
  return projectCwd && !canReadCwd(projectCwd) ? { ...catalog, projectCwd: null } : catalog
}

export function deviceHintKey(peer: string, request: SubscribeRequest): string {
  return [peer, request.subscriptionId, request.views.includes('detail') ? 'detail' : undefined].filter(Boolean).join(':')
}

export function deviceOutcome(outcome: Evidence<string> | null): unknown {
  if (!outcome) return null
  const { source: _hostEvidence, ...display } = outcome
  return display
}

export function deviceEventPayload(
  payload: Record<string, unknown>,
  canReadCwd: (cwd: string | null) => boolean
): Record<string, unknown> {
  const display: Record<string, unknown> = {}
  for (const field of DEVICE_FIELDS) {
    const value = payload[field]
    if (value === null || typeof value === 'string' || typeof value === 'number') {
      if (field === 'cwd' && !canReadCwd(typeof value === 'string' ? value : null)) continue
      display[field] = value
    }
  }
  for (const field of ['promptPreview', 'userTextPreview']) {
    if (typeof payload[field] === 'string') display[field] = payload[field].slice(0, PROMPT_PREVIEW_MAX_CHARS)
  }
  if (typeof payload.reason === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(payload.reason)) {
    display.reason = payload.reason
  }
  if (payload.outcome && typeof payload.outcome === 'object') display.outcome = deviceOutcome(payload.outcome as Evidence<string>)
  if (payload.catalog && typeof payload.catalog === 'object') {
    const { nativeSessionId, projectCwd, preview, runtimeProvider } = payload.catalog as SessionCatalogMetadata
    display.catalog = visibleCatalog({ nativeSessionId, projectCwd, preview, runtimeProvider }, canReadCwd)
  }
  return display
}

export function deviceTurn(turn: TurnProjectionRow): Record<string, unknown> {
  const { evidence: _evidence, contentRef: _contentRef, outcome, userTextPreview, ...display } = turn
  return { ...display, outcome: deviceOutcome(outcome), userTextPreview: userTextPreview?.slice(0, PROMPT_PREVIEW_MAX_CHARS) ?? null }
}
