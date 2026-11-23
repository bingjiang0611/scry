import type { ProviderId } from '@shared/provider'
import { PROVIDER_IDS } from './hooks/integration-model'

export interface StoredSessionSelection {
  cwd: string
  sessionId: string | null
  providerId: ProviderId
  externalSessionId?: string
  agentProfileId?: string
}

export const SESSION_SELECTION_STORAGE_KEY = 'scry.session-selection.v1'

type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem' | 'removeItem'>

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export function parseStoredSessionSelection(raw: string | null): StoredSessionSelection | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const cwd = optionalString(record.cwd)
  const providerId = PROVIDER_IDS.find((candidate) => candidate === record.providerId)
  if (!cwd || !providerId) return null
  return {
    cwd,
    sessionId: optionalString(record.sessionId) ?? null,
    providerId,
    externalSessionId: optionalString(record.externalSessionId),
    agentProfileId: optionalString(record.agentProfileId)
  }
}

export function readStoredSessionSelection(storage: StorageReader | undefined): StoredSessionSelection | null {
  try {
    return parseStoredSessionSelection(storage?.getItem(SESSION_SELECTION_STORAGE_KEY) ?? null)
  } catch {
    return null
  }
}

export function persistSessionSelection(
  selection: StoredSessionSelection | null,
  storage: StorageWriter | undefined
): void {
  try {
    if (!selection) storage?.removeItem(SESSION_SELECTION_STORAGE_KEY)
    else storage?.setItem(SESSION_SELECTION_STORAGE_KEY, JSON.stringify(selection))
  } catch {
  }
}

export function sessionSelectionAfterTurnDone(
  event: {
    runId?: string
    sessionId?: string
    externalSessionId?: string
    providerId?: string
    agentProfileId?: string
  },
  previousSessionId: string | null,
  owner: { cwd: string | null; providerId: ProviderId; agentProfileId?: string } | undefined
): {
  cwd: string
  sessionId: string
  providerId: ProviderId
  externalSessionId?: string
  agentProfileId?: string
} | null {
  if (!event.sessionId || !owner?.cwd) return null
  const ownsView = previousSessionId == null ||
    previousSessionId === event.runId ||
    previousSessionId === event.sessionId ||
    previousSessionId === event.externalSessionId
  if (!ownsView) return null
  const providerId = PROVIDER_IDS.find((candidate) => candidate === event.providerId) ?? owner.providerId
  return {
    cwd: owner.cwd,
    sessionId: event.sessionId,
    providerId,
    externalSessionId: event.externalSessionId,
    agentProfileId: event.agentProfileId ?? owner.agentProfileId
  }
}
