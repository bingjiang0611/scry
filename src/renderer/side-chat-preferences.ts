import { isAgentPermissionMode, type AgentModelRef, type AgentPermissionMode } from '@shared/runtime'

/** Last explicit runtime choice of one side chat; an intent, never capability evidence. */
export interface SideChatPreferences {
  agentId: string
  model?: AgentModelRef
  effort?: string
  permissionMode: AgentPermissionMode
}

const STORAGE_KEY = 'scry.side-chat-preferences.v1'
const MAX_ENTRIES = 64

function validModel(value: unknown): AgentModelRef | undefined {
  if (!value || typeof value !== 'object') return undefined
  const model = value as { id?: unknown; providerId?: unknown }
  if (typeof model.id !== 'string' || !model.id || model.id.length > 240) return undefined
  return { id: model.id, ...(typeof model.providerId === 'string' && model.providerId.length <= 240
    ? { providerId: model.providerId } : {}) }
}

function validPreferences(value: unknown): SideChatPreferences | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<SideChatPreferences>
  if (typeof item.agentId !== 'string' || !item.agentId || item.agentId.length > 200) return undefined
  if (!isAgentPermissionMode(item.permissionMode)) return undefined
  const effort = typeof item.effort === 'string' && item.effort && item.effort.length <= 240 ? item.effort : undefined
  const model = validModel(item.model)
  return { agentId: item.agentId, permissionMode: item.permissionMode,
    ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** localStorage is absent outside a renderer (tests, static render); preferences are then empty. */
function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** Bounded per-side-chat preferences so reopening a tab keeps the last explicit choice. */
export function readSideChatPreferences(
  storage: Pick<Storage, 'getItem'> | undefined = defaultStorage()
): Map<string, SideChatPreferences> {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Map()
    const entries = new Map<string, SideChatPreferences>()
    for (const row of parsed.slice(-MAX_ENTRIES)) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0]) continue
      const value = validPreferences(row[1])
      if (value) entries.set(row[0], value)
    }
    return entries
  } catch {
    return new Map()
  }
}

export function writeSideChatPreference(
  conversationId: string,
  value: SideChatPreferences,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultStorage()
): void {
  try {
    if (!storage) return
    const entries = readSideChatPreferences(storage)
    entries.delete(conversationId)
    entries.set(conversationId, value)
    const rows = [...entries.entries()].slice(-MAX_ENTRIES)
    storage.setItem(STORAGE_KEY, JSON.stringify(rows))
  } catch {
    // A lost preference only changes the next seed back to the persisted side-chat
    // target; it never changes what the host actually sends.
  }
}
