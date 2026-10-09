import { useEffect, useRef, useState } from 'react'
import type { Turn } from '../format'

/** Sample expensive read-only summaries, not trace ingestion or terminal evidence. */
export function useSampledTurns(liveTurns: Turn[], scope: string | null, busy: boolean): Turn[] {
  const latestTurns = useRef(liveTurns)
  latestTurns.current = liveTurns
  const sampleTimer = useRef<number | null>(null)
  const turnsUpdatedAt = useRef(0)
  const [sample, setSample] = useState({ scope, turns: liveTurns })
  // Never show another session's evidence or delay the final snapshot behind the timer.
  const turns = sample.scope === scope && busy ? sample.turns : liveTurns
  useEffect(() => {
    if (!busy || sample.scope !== scope) {
      if (sampleTimer.current !== null) window.clearTimeout(sampleTimer.current)
      sampleTimer.current = null
      turnsUpdatedAt.current = Date.now()
      setSample({ scope, turns: liveTurns })
      return
    }
    const remaining = 200 - (Date.now() - turnsUpdatedAt.current)
    if (remaining <= 0) {
      turnsUpdatedAt.current = Date.now()
      setSample({ scope, turns: liveTurns })
      return
    }
    if (sampleTimer.current === null) {
      sampleTimer.current = window.setTimeout(() => {
        sampleTimer.current = null
        turnsUpdatedAt.current = Date.now()
        setSample({ scope, turns: latestTurns.current })
      }, remaining)
    }
  }, [busy, liveTurns, sample.scope, scope])
  useEffect(() => () => {
    if (sampleTimer.current !== null) window.clearTimeout(sampleTimer.current)
  }, [])
  return turns
}
