import { useCallback, useState } from 'react'

import type { DiffScope } from '../turn-diff'

export type DiffReviewSelection = { scope: DiffScope; runId?: string; initialPath?: string }

export function useDiffReviewSelection(surfaceId: string) {
  const [selections, setSelections] = useState<ReadonlyMap<string, DiffReviewSelection>>(() => new Map())
  const selection = selections.get(surfaceId) ?? null
  const select = useCallback((nextSelection: DiffReviewSelection | null): void => {
    setSelections((previous) => {
      const next = new Map(previous)
      if (nextSelection) next.set(surfaceId, nextSelection)
      else next.delete(surfaceId)
      return next
    })
  }, [surfaceId])
  return [selection, select] as const
}
