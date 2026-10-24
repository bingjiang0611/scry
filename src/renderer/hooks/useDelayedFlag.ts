import { useEffect, useState } from 'react'

// Delay decoration only. Callers keep authority and aria-busy on the raw flag.
export function useDelayedFlag(flag: boolean, delayMs = 150): boolean {
  const [state, setState] = useState({ flag, delayMs, visible: false })
  const changed = state.flag !== flag || state.delayMs !== delayMs
  // Retire old visibility before commit, not in a deferred passive effect:
  // a fast false→true cycle must never mount the previous request's loader.
  if (changed) setState({ flag, delayMs, visible: false })
  useEffect(() => {
    if (!flag) return
    const timer = setTimeout(() => setState(current =>
      current.flag === flag && current.delayMs === delayMs ? { ...current, visible: true } : current
    ), delayMs)
    return () => clearTimeout(timer)
  }, [flag, delayMs])
  return flag && !changed && state.visible
}
