import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRightSurfaceState, reduceRightSurfaceState, type RightSurfaceAction } from '../right-surface'
import {
  migrateRightSurfaces, persistSurfaces, restoreSurfaces, SURFACE_STORAGE_KEY,
  type SessionRightSurface
} from '../right-surface-storage'

export type { SessionRightSurface }
export { migrateRightSurfaces, restoreSurfaces }

export function useSessionRightSurfaces(key: string, cwd: string | null, storageKey = SURFACE_STORAGE_KEY) {
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
  // The selected workbench changes on every tab action. Keeping it in a ref keeps
  // `dispatch` stable, so callers that memoize on it do not rebuild every render.
  const currentRef = useRef(current)
  currentRef.current = current
  const dispatch = useCallback((action: RightSurfaceAction): void => {
    const target = currentRef.current
    setSurfaces((previous) => {
      const storageEntry = [...previous].find(([, entry]) => entry.id === target.id)?.[0] ?? key
      const entry = previous.get(storageEntry) ?? target
      const state = reduceRightSurfaceState(entry.state, action)
      if (state === entry.state) return previous
      return new Map(previous).set(storageEntry, { ...entry, state,
        terminalMounted: entry.terminalMounted || (action.type === 'open' && action.kind === 'terminal') })
    })
  }, [key])
  /**
   * Applies one action to the stored layout of a scope that is not the selected one.
   *
   * A child created while the user switched parents is persisted to its own scope's tab
   * list without selecting that scope, showing it, or disturbing the parent on screen.
   */
  const dispatchForScope = useCallback((scopeKey: string, action: RightSurfaceAction): void => {
    if (scopeKey === key) { dispatch(action); return }
    setSurfaces((previous) => {
      const entry = previous.get(scopeKey)
      if (!entry) {
        // A scope that was never mounted still needs its own row; the tab is durable and
        // appears when the user opens that parent.
        return new Map(previous).set(scopeKey, {
          id: crypto.randomUUID(), cwd: null, state: reduceRightSurfaceState(createRightSurfaceState({ visible: false }), action)
        })
      }
      return new Map(previous).set(scopeKey, { ...entry, state: reduceRightSurfaceState(entry.state, action) })
    })
  }, [dispatch, key])
  const migrate = useCallback((from: string, to: string): void => {
    // An untouched surface is already mounted but is not in the saved map yet.
    // Promote that same tree too, rather than minting a new identity on switch.
    setSurfaces(previous => migrateRightSurfaces(
      from === key && !previous.has(from) ? new Map(previous).set(from, owner) : previous,
      from, to
    ))
  }, [key, owner])
  /**
   * Reconciliation after a bounded summary read: ids proven deleted close their view,
   * ids that merely failed to read stay open. Display state only; no child record is
   * touched.
   */
  const dropSideChats = useCallback((conversationIds: readonly string[]): void => {
    if (conversationIds.length === 0) return
    dispatch({ type: 'drop-side-chats', conversationIds })
  }, [dispatch])
  const [layoutSaved, setLayoutSaved] = useState(true)
  useEffect(() => {
    // A storage failure keeps the in-memory layout and never closes a shell or drops a
    // child tab, but it is reported instead of being swallowed: the layout would not
    // survive a restart.
    setLayoutSaved(persistSurfaces(surfaces, storageKey))
  }, [surfaces, storageKey])
  return {
    current, choices, selectedIndex, selectNext, surfaces: [...surfaces.values()],
    dispatch, dispatchForScope, migrate, dropSideChats, layoutSaved
  }
}
