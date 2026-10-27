import { useMemo } from 'react'
import type { TraceEvent } from '@shared/trace'

const WINDOW_THRESHOLD = 96
const VISIBLE_ITEMS = 64

export function useCompletedTurnFlow(
  items: TraceEvent[],
  options: { completed: boolean; expanded: boolean; selectedId: string | null }
): { items: TraceEvent[]; hiddenCount: number } {
  return useMemo(() => {
    const selectedInEarlierFlow = options.selectedId !== null && items
      .slice(0, -VISIBLE_ITEMS)
      .some(event => event.id === options.selectedId)
    const windowed = options.completed && items.length > WINDOW_THRESHOLD &&
      !options.expanded && !selectedInEarlierFlow
    const visible = windowed ? items.slice(-VISIBLE_ITEMS) : items
    return { items: visible, hiddenCount: items.length - visible.length }
  }, [items, options.completed, options.expanded, options.selectedId])
}
