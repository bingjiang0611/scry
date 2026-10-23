import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { MOTION, prefersReducedMotion, subscribeReducedMotion } from '../motion'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function useTabIndicator(container: RefObject<HTMLElement>, selected: string | null, items: ReadonlyMap<string, HTMLElement | null>) {
  const indicatorRef = useRef<HTMLSpanElement>(null)
  const animation = useRef<Animation | null>(null)
  const previous = useRef<{ selected: string | null; order: string }>()
  const geometry = useRef<{ x: number; width: number }>()
  const cancel = (): void => { animation.current?.cancel(); animation.current = null }
  const position = (animate: boolean): void => {
    const target = selected == null ? null : items.get(selected)
    const indicator = indicatorRef.current
    if (!indicator || !container.current) return
    if (!target) {
      cancel(); indicator.hidden = true; delete container.current.dataset.indicatorReady; geometry.current = undefined
      return
    }
    const next = { x: target.offsetLeft, width: target.offsetWidth }
    if (geometry.current?.x === next.x && geometry.current.width === next.width) return
    const from = animate ? getComputedStyle(indicator).transform : 'none'
    // All geometry/current-presentation reads precede writes and cancellation.
    cancel()
    const transform = `translateX(${next.x}px) scaleX(${next.width})`
    indicator.hidden = false
    indicator.style.transform = transform
    container.current.dataset.indicatorReady = 'true'
    geometry.current = next
    if (animate && !prefersReducedMotion()) {
      animation.current = indicator.animate([{ transform: from }, { transform }], {
        id: 'scry-tab-indicator', duration: MOTION.durBase, easing: MOTION.easeStruct
      })
    }
  }
  const latestPosition = useRef(position)
  latestPosition.current = position
  useBrowserLayoutEffect(() => {
    // Ref maps retain null entries after close; compare the actual DOM order.
    const order = [...items].filter((entry): entry is [string, HTMLElement] => entry[1] !== null)
      .sort((a, b) => a[1].compareDocumentPosition(b[1]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
      .map(([key]) => key).join('\0')
    const animate = previous.current !== undefined && previous.current.order === order && previous.current.selected !== selected
    position(animate)
    previous.current = { selected, order }
  })
  useEffect(() => {
    const observer = new ResizeObserver(() => latestPosition.current(false))
    if (container.current) observer.observe(container.current)
    for (const item of items.values()) if (item) observer.observe(item)
    return () => observer.disconnect()
  })
  useEffect(() => {
    const unsubscribe = subscribeReducedMotion(reduced => { if (reduced) { cancel(); latestPosition.current(false) } })
    return () => { unsubscribe(); cancel() }
  }, [])
  return { indicatorRef }
}
