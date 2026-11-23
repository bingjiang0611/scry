import { useEffect, useState } from 'react'

/** Below this, a wait shows no separate loader: one that comes and goes reads as a flicker. */
export const LOADER_DELAY_MS = 300
/** A loader that did appear stays at least this long, so it never flashes. */
export const LOADER_MIN_VISIBLE_MS = 500

type DelayedFlagState = { flag: boolean; delayMs: number; visible: boolean; shownAt: number }

// Delay decoration only. Use the raw flag for aria-busy and to reveal ready content.
export function useDelayedFlag(flag: boolean, delayMs = LOADER_DELAY_MS, minVisibleMs = LOADER_MIN_VISIBLE_MS): boolean {
  const [state, setState] = useState<DelayedFlagState>({ flag, delayMs, visible: false, shownAt: 0 })
  let current = state
  if (state.flag !== flag || state.delayMs !== delayMs) {
    // A loader already on screen keeps its place (it is holding its minimum or the
    // next wait began during the hold); one not yet shown starts a fresh delay.
    current = { ...state, flag, delayMs }
    setState(current)
  }
  const { visible, shownAt } = current
  useEffect(() => {
    if (flag && !visible) {
      const timer = setTimeout(() => setState((latest) =>
        latest.flag && latest.delayMs === delayMs && !latest.visible ? { ...latest, visible: true, shownAt: Date.now() } : latest
      ), delayMs)
      return () => clearTimeout(timer)
    }
    if (!flag && visible) {
      const remaining = Math.max(0, minVisibleMs - (Date.now() - shownAt))
      const timer = setTimeout(() => setState((latest) =>
        !latest.flag && latest.visible ? { ...latest, visible: false } : latest
      ), remaining)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [flag, delayMs, minVisibleMs, visible, shownAt])
  return visible
}
