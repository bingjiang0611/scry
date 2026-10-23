import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { MOTION, prefersReducedMotion, subscribeReducedMotion } from '../motion'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

// The budget includes keyed headings. Oversized lists retain every DOM row but
// skip decoration; resuming below the budget seeds positions without fake arrivals.
export function useFlipList(root: RefObject<HTMLElement>, revision: unknown): void {
  const positions = useRef(new Map<string, number>())
  const animations = useRef(new Map<string, Animation>())
  const initialized = useRef(false)
  const oversized = useRef(false)
  const cancel = (): void => {
    for (const animation of animations.current.values()) animation.cancel()
    animations.current.clear()
  }
  useBrowserLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const nodes = Array.from(element.querySelectorAll<HTMLElement>('[data-motion-key]'))
    // Keep every row in the DOM. An oversized list is a deliberate no-FLIP
    // boundary: querying keys is cheap, but geometry reads would be O(n) layout.
    if (nodes.length > 40) {
      cancel()
      positions.current.clear()
      oversized.current = true
      return
    }
    const measurements = nodes.map(node => {
      const key = node.dataset.motionKey!
      const previous = positions.current.get(key)
      // Read the current transform before cancelling the old animation so a
      // second update continues from the displayed position.
      const transform = animations.current.has(key) ? getComputedStyle(node).transform : 'none'
      const translation = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42
      const top = node.offsetTop
      const entering = initialized.current && !oversized.current && previous === undefined
      return { node, key, top, entering, delta: previous === undefined ? entering ? -4 : 0 : previous + translation - top }
    })
    // No cancellations or animation writes until every position/transform is read.
    cancel()
    positions.current = new Map(measurements.map(({ key, top }) => [key, top]))
    initialized.current = true
    const resumed = oversized.current
    oversized.current = false
    if (resumed || prefersReducedMotion()) return
    for (const { node, key, delta, entering } of measurements) {
      if (!entering && Math.abs(delta) < 1) continue
      const animation = node.animate([
        { transform: `translateY(${delta}px)`, opacity: entering ? 0 : 1 },
        { transform: 'translateY(0)', opacity: 1 }
      ], {
        id: entering ? 'scry-list-arrival' : 'scry-list-reorder',
        duration: entering ? MOTION.durBase : MOTION.durSlow,
        easing: entering ? MOTION.easeOut : MOTION.easeStruct
      })
      animations.current.set(key, animation)
      animation.onfinish = () => { if (animations.current.get(key) === animation) animations.current.delete(key) }
    }
  }, [revision])
  useEffect(() => {
    const unsubscribe = subscribeReducedMotion(reduced => { if (reduced) cancel() })
    return () => { unsubscribe(); cancel() }
  }, [])
}
