import {
  createRightSurfaceState, MAX_SIDE_CHAT_TABS, RIGHT_SURFACE_KINDS, reduceRightSurfaceState,
  type RightSurfaceAction, type RightSurfaceState
} from './right-surface'

export interface SessionRightSurface {
  /** Stable across draft -> run -> native session promotion, including renderer reload. */
  id: string
  cwd: string | null
  state: RightSurfaceState
  terminalMounted?: boolean
  /** A native session may already have been opened before a late promotion. */
  relatedIds?: string[]
}

/** Local workbenches persist across reloads; the remote namespace stays session-scoped. */
const DURABLE_PREFIX = 'scry.session-right-surfaces.'
const LEGACY_SESSION_STORAGE_KEY = 'scry.session-right-surfaces.v1'
export const SURFACE_STORAGE_KEY = 'scry.session-right-surfaces.v2'

export function isDurableSurfaceKey(storageKey: string): boolean {
  return storageKey.startsWith(DURABLE_PREFIX)
}

function storageOf(durable: boolean): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    if (typeof window === 'undefined') return undefined
    return durable ? window.localStorage : window.sessionStorage
  } catch {
    return undefined
  }
}

export function migrateRightSurfaces(
  surfaces: ReadonlyMap<string, SessionRightSurface>, from: string, to: string
): ReadonlyMap<string, SessionRightSurface> {
  if (from === to || !surfaces.has(from)) return surfaces
  const next = new Map(surfaces)
  const source = next.get(from)!
  // Do not discard either mounted tree when the native session was already
  // opened. Both remain selectable from the resulting conversation.
  const target = next.get(to)
  next.delete(from)
  if (target && target.id !== source.id) {
    next.set(to, { ...source, relatedIds: [...new Set([
      ...(source.relatedIds ?? []), target.id, ...(target.relatedIds ?? [])
    ])].filter((id) => id !== source.id) })
    next.set(target.id, target)
  } else next.set(to, source)
  return next
}

function validSideChats(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128))]
    // The tab strip shows at most eight children. This is a display bound on the view
    // state only: the children themselves are durable records and are never deleted.
    .slice(-MAX_SIDE_CHAT_TABS)
}

function restoreRow(row: unknown): [string, SessionRightSurface] | undefined {
  if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string') return undefined
  const value = row[1] as SessionRightSurface | null
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 128) return undefined
  if (value.relatedIds !== undefined &&
    !(Array.isArray(value.relatedIds) && value.relatedIds.every((id) => typeof id === 'string'))) return undefined
  if (value.cwd !== null && typeof value.cwd !== 'string') return undefined
  const state = value.state as Partial<RightSurfaceState> | undefined
  if (!state || !Array.isArray(state.openIds) || !state.openIds.every((kind) => RIGHT_SURFACE_KINDS.includes(kind))) return undefined
  if (state.activeId !== null && state.activeId !== undefined && !RIGHT_SURFACE_KINDS.includes(state.activeId)) return undefined
  if (typeof state.visible !== 'boolean' || typeof state.maximized !== 'boolean') return undefined
  const sideChats = validSideChats(state.sideChats)
  const restored = createRightSurfaceState({
    openIds: state.openIds,
    activeId: state.activeId ?? null,
    visible: state.visible,
    maximized: state.maximized
  })
  const activeSideChatId = typeof state.activeSideChatId === 'string' && sideChats.includes(state.activeSideChatId)
    ? state.activeSideChatId
    : null
  return [row[0], {
    id: value.id,
    cwd: value.cwd,
    state: { ...restored, sideChats, activeSideChatId },
    // Absent stays absent: an untouched workbench has no terminal to retain.
    ...(value.terminalMounted === true ? { terminalMounted: true } : {}),
    ...(value.relatedIds ? { relatedIds: [...new Set(value.relatedIds)] } : {})
  }]
}

/** Parses one stored namespace; a malformed row is dropped instead of guessed. */
export function parseSurfaces(raw: string | null): ReadonlyMap<string, SessionRightSurface> {
  try {
    const rows: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(rows)) return new Map()
    const parsed: Array<[string, SessionRightSurface]> = []
    for (const row of rows) {
      const entry = restoreRow(row)
      if (entry) parsed.push(entry)
    }
    return new Map(parsed)
  } catch {
    return new Map()
  }
}

/**
 * Restores one workbench namespace.
 *
 * The local namespace is durable (`localStorage`). A workbench saved by the older
 * session-scoped build is read once from `sessionStorage` so an upgrade does not lose
 * an open layout, and the caller persists the migrated copy immediately.
 */
export function restoreSurfaces(storageKey = SURFACE_STORAGE_KEY): ReadonlyMap<string, SessionRightSurface> {
  const durable = isDurableSurfaceKey(storageKey)
  const storage = storageOf(durable)
  const restored = parseSurfaces(storage?.getItem(storageKey) ?? null)
  if (restored.size > 0 || !durable) return restored
  return parseSurfaces(storageOf(false)?.getItem(LEGACY_SESSION_STORAGE_KEY) ?? null)
}

export function persistSurfaces(surfaces: ReadonlyMap<string, SessionRightSurface>, storageKey: string): boolean {
  const storage = storageOf(isDurableSurfaceKey(storageKey))
  if (!storage) return false
  try {
    storage.setItem(storageKey, JSON.stringify([...surfaces]))
    return true
  } catch {
    // Navigation still works in memory; a storage failure cannot terminate shells.
    return false
  }
}

export type { RightSurfaceAction, RightSurfaceState }
export { reduceRightSurfaceState }
