import { useEffect, useState, type RefObject } from 'react'

/**
 * Measured width of one element, using the browser's own resize notifications.
 *
 * This is the existing measured-layout technique in this renderer: no window polling and
 * no global resize listener. The observer runs only while a caller with a real element is
 * mounted, and an absent element (static render, tests) reports `false`.
 */
export function useMeasuredNarrow(ref: RefObject<HTMLElement>, thresholdPx: number): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = (width: number): void => setNarrow(width < thresholdPx)
    update(element.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) update(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, thresholdPx])
  return narrow
}
