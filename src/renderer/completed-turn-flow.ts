import { useMemo } from 'react'
import type { TraceEvent } from '@shared/trace'

const WINDOW_THRESHOLD = 96
const VISIBLE_ITEMS = 16
const TEXT_WINDOW_THRESHOLD = 24_000
const VISIBLE_TEXT_CHARACTERS = 8_000

interface CompletedTurnFlowOptions {
  completed: boolean
  expanded: boolean
  selectedId: string | null
}

export function completedTurnFlow(
  items: TraceEvent[],
  options: CompletedTurnFlowOptions
): { items: TraceEvent[]; hiddenCount: number } {
  const selectedInEarlierFlow = options.selectedId !== null && items
    .slice(0, -VISIBLE_ITEMS)
    .some(event => event.id === options.selectedId)
  const windowed = options.completed && items.length > WINDOW_THRESHOLD &&
    !options.expanded && !selectedInEarlierFlow
  const visible = windowed ? items.slice(-VISIBLE_ITEMS) : items
  return { items: visible, hiddenCount: items.length - visible.length }
}

export function completedModelText(
  text: string,
  options: Pick<CompletedTurnFlowOptions, 'completed' | 'expanded'>
): { text: string; hiddenCharacters: number } {
  const windowed = options.completed && !options.expanded && text.length > TEXT_WINDOW_THRESHOLD
  if (!windowed) return { text, hiddenCharacters: 0 }
  const lastVisible = text.charCodeAt(VISIBLE_TEXT_CHARACTERS - 1)
  const firstHidden = text.charCodeAt(VISIBLE_TEXT_CHARACTERS)
  const visibleCharacters = lastVisible >= 0xD800 && lastVisible <= 0xDBFF && firstHidden >= 0xDC00 && firstHidden <= 0xDFFF
    ? VISIBLE_TEXT_CHARACTERS - 1
    : VISIBLE_TEXT_CHARACTERS
  return {
    text: text.slice(0, visibleCharacters),
    hiddenCharacters: text.length - visibleCharacters
  }
}

export function useCompletedTurnFlow(
  items: TraceEvent[],
  options: CompletedTurnFlowOptions
): { items: TraceEvent[]; hiddenCount: number } {
  return useMemo(
    () => completedTurnFlow(items, options),
    [items, options.completed, options.expanded, options.selectedId]
  )
}
