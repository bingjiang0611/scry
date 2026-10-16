import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRightSurfaceState, reduceRightSurfaceState, RIGHT_SURFACE_KINDS, type RightSurfaceAction, type RightSurfaceState } from '../right-surface'

export interface SessionRightSurface {
  /** Stable across draft -> run -> native session promotion, including renderer reload. */
  id: string
  cwd: string | null
  state: RightSurfaceState
  terminalMounted?: boolean
  /** A native session may already have been opened before a late promotion. */
  relatedIds?: string[]
}

const STORAGE_KEY = 'scry.session-right-surfaces.v1'

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
    next.set(target.id, target)
    next.set(to, { ...source, relatedIds: [...new Set([
      ...(source.relatedIds ?? []), target.id, ...(target.relatedIds ?? [])
    ])].filter((id) => id !== source.id) })
  } else next.set(to, source)
  return next
}

export function restoreSurfaces(storageKey = STORAGE_KEY): ReadonlyMap<string, SessionRightSurface> {
  try {
    const rows: unknown = JSON.parse(window.sessionStorage.getItem(storageKey) ?? '[]')
    if (!Array.isArray(rows)) return new Map()
    return new Map(rows.filter((row): row is [string, SessionRightSurface] => {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string') return false
      const value = row[1] as SessionRightSurface | null
      return Boolean(value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128 &&
        (value.relatedIds === undefined || (Array.isArray(value.relatedIds) && value.relatedIds.every(id => typeof id === 'string'))) &&
        (value.cwd === null || typeof value.cwd === 'string') && value.state &&
        Array.isArray(value.state.openIds) && value.state.openIds.every((kind) => RIGHT_SURFACE_KINDS.includes(kind)) &&
        (value.state.activeId === null || RIGHT_SURFACE_KINDS.includes(value.state.activeId)) &&
        typeof value.state.visible === 'boolean' && typeof value.state.maximized === 'boolean')
    }))
  } catch {
    return new Map()
  }
}

export function useSessionRightSurfaces(key: string, cwd: string | null, storageKey = STORAGE_KEY) {
  const [surfaces, setSurfaces] = useState(() => restoreSurfaces(storageKey))
  const owner = useMemo<SessionRightSurface>(() => surfaces.get(key) ?? {
    id: crypto.randomUUID(), cwd, state: createRightSurfaceState({ visible: false })
  }, [surfaces, key, cwd])
  const [selectedIds, setSelectedIds] = useState<ReadonlyMap<string, string>>(() => new Map())
  const choices = [owner, ...[...surfaces.values()].filter(surface => owner.relatedIds?.includes(surface.id))]
  const selectedIndex = Math.max(0, choices.findIndex(surface => surface.id === selectedIds.get(owner.id)))
  const current = choices[selectedIndex]
  const selectNext = (): void => {
    const next = choices[(selectedIndex + 1) % choices.length]
    setSelectedIds(previous => new Map(previous).set(owner.id, next.id))
  }
  const dispatch = useCallback((action: RightSurfaceAction): void => {
    setSurfaces((previous) => {
      const storageKey = [...previous].find(([, entry]) => entry.id === current.id)?.[0] ?? key
      const entry = previous.get(storageKey) ?? current
      return new Map(previous).set(storageKey, { ...entry, state: reduceRightSurfaceState(entry.state, action),
        terminalMounted: entry.terminalMounted || (action.type === 'open' && action.kind === 'terminal') })
    })
  }, [key, current])
  const migrate = useCallback((from: string, to: string): void => {
    // An untouched surface is already mounted but is not in the saved map yet.
    // Promote that same tree too, rather than minting a new identity on switch.
    setSurfaces(previous => migrateRightSurfaces(
      from === key && !previous.has(from) ? new Map(previous).set(from, owner) : previous,
      from, to
    ))
  }, [key, owner])
  useEffect(() => {
    try { window.sessionStorage.setItem(storageKey, JSON.stringify([...surfaces])) } catch {
      // Navigation still works in memory; storage failure cannot terminate shells.
    }
  }, [surfaces, storageKey])
  return { current, choices, selectedIndex, selectNext, surfaces: [...surfaces.values()], dispatch, migrate }
}
