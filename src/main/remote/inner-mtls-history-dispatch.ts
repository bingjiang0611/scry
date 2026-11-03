import type { HostController } from './host-controller'
import { historyProfileSelection, historyScopeSelection } from './remote-gateway'
import type { RemoteRequestEnvelope } from './inner-mtls-dispatch'

// Structured-history reads carry a profile scope option that older clients omit.
// Both normalizations live here so the request envelope is validated once, at the
// same place the scope is applied to the controller query.
function scopeOf(request: RemoteRequestEnvelope) {
  const scope = historyScopeSelection(request).historyScope ?? 'profile'
  const profile = scope === 'profile' ? historyProfileSelection(request, true) : historyProfileSelection(request)
  return { scope, profile, ...(Object.hasOwn(request, 'historyScope') ? { historyScope: scope } : {}) }
}

// Dispatches the history-family reads. Returns undefined for every other op so
// the caller keeps one ordered chain for the remaining vocabulary.
export async function dispatchHistoryRequest(controller: HostController, fingerprint: string, request: RemoteRequestEnvelope): Promise<unknown | undefined> {
  if (request.op === 'historyPreview') {
    const { scope, profile, ...scoped } = scopeOf(request)
    if (typeof request.providerId !== 'string' || typeof request.cwd !== 'string' || typeof request.externalSessionId !== 'string') return { error: 'invalid_request' }
    return { historyScope: scope, ...(scope === 'profile' ? { historyProfile: profile } : {}), historyPreview: await controller.readHistoryPreview(fingerprint, { ...scoped, ...profile, providerId: request.providerId, cwd: request.cwd, externalSessionId: request.externalSessionId }) }
  }
  if (request.op === 'historyVersion') {
    const { scope, profile, ...scoped } = scopeOf(request)
    if (typeof request.providerId !== 'string' || typeof request.cwd !== 'string' || typeof request.externalSessionId !== 'string') return { error: 'invalid_request' }
    return { historyScope: scope, ...(scope === 'profile' ? { historyProfile: profile } : {}), historyVersion: await controller.readHistoryVersion(fingerprint, { ...scoped, ...profile, providerId: request.providerId, cwd: request.cwd, externalSessionId: request.externalSessionId }) }
  }
  if (request.op === 'historyTurnsPage') {
    const { scope, profile, ...scoped } = scopeOf(request)
    if (typeof request.providerId !== 'string' || typeof request.cwd !== 'string' || typeof request.externalSessionId !== 'string' ||
        (request.before !== undefined && !Number.isSafeInteger(request.before)) ||
        (request.limit !== undefined && !Number.isSafeInteger(request.limit)) ||
        (request.snapshot !== undefined && typeof request.snapshot !== 'string')) return { error: 'invalid_request' }
    return { historyScope: scope, ...(scope === 'profile' ? { historyProfile: profile } : {}), historyTurnsPage: await controller.readHistoryTurnsPage(fingerprint, {
      ...scoped, ...profile,
      providerId: request.providerId, cwd: request.cwd, externalSessionId: request.externalSessionId,
      ...(typeof request.before === 'number' ? { before: request.before } : {}),
      ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
      ...(typeof request.snapshot === 'string' ? { snapshot: request.snapshot } : {})
    }) }
  }
  if (request.op === 'history') {
    const { scope, profile, ...scoped } = scopeOf(request)
    // Legacy bounded response retained for older clients.
    if (typeof request.providerId !== 'string' || typeof request.externalSessionId !== 'string') return { error: 'invalid_request' }
    return { historyScope: scope, ...(scope === 'profile' ? { historyProfile: profile } : {}), history: await controller.readHistory(fingerprint, { ...scoped, ...profile, providerId: request.providerId, cwd: typeof request.cwd === 'string' ? request.cwd : '', externalSessionId: request.externalSessionId }) }
  }
  if (request.op === 'historyPage') {
    const { scope, profile, ...scoped } = scopeOf(request)
    if (typeof request.providerId !== 'string' || typeof request.externalSessionId !== 'string' ||
        (request.cursor !== undefined && !Number.isSafeInteger(request.cursor)) ||
        (request.limit !== undefined && !Number.isSafeInteger(request.limit)) ||
        (request.snapshot !== undefined && typeof request.snapshot !== 'string')) return { error: 'invalid_request' }
    return { historyScope: scope, ...(scope === 'profile' ? { historyProfile: profile } : {}), historyPage: await controller.readHistoryPage(fingerprint, {
      ...scoped, ...profile,
      providerId: request.providerId,
      cwd: typeof request.cwd === 'string' ? request.cwd : '',
      externalSessionId: request.externalSessionId,
      ...(typeof request.cursor === 'number' ? { cursor: request.cursor } : {}),
      ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
      ...(typeof request.snapshot === 'string' ? { snapshot: request.snapshot } : {})
    }) }
  }
  return undefined
}

// `liveRuns` joins one opened session's version to the live-run long-poll.
// Returns undefined when absent and false when malformed.
export function parseLiveRunsHistory(value: unknown): { query: { providerId: string; cwd: string; externalSessionId: string; historyScope: 'session' | 'profile'; agentProfileId?: string | null }; known?: string } | undefined | false {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const h = value as Record<string, unknown>
  const text = (field: unknown, max: number): field is string => typeof field === 'string' && field.length > 0 && field.length <= max
  if (!text(h.providerId, 128) || !text(h.cwd, 4096) || !text(h.externalSessionId, 256)) return false
  if (h.known !== undefined && !text(h.known, 512)) return false
  const scope = historyScopeSelection(h).historyScope ?? 'profile'
  const profile = scope === 'profile' ? historyProfileSelection(h, true) : historyProfileSelection(h)
  return { query: { providerId: h.providerId, cwd: h.cwd, externalSessionId: h.externalSessionId, historyScope: scope, ...profile }, ...(h.known !== undefined ? { known: h.known as string } : {}) }
}
