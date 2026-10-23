import { flushSync } from 'react-dom'
import { MOTION, prefersReducedMotion, subscribeReducedMotion } from './motion'
import { cancelStructuralMotion } from './structural-motion'

const active = new Map<HTMLElement, () => void>()
const paneSelector = '#sidebar-pane, #right-surface-pane, #remote-right-surface-pane'

export function cancelPaneMotion(): void {
  for (const cancel of active.values()) cancel()
}

/** Fallback F: layout commits once. Only a pane's transform/opacity is animated. */
export function animatePaneChange(commit: () => void): void {
  cancelPaneMotion()
  cancelStructuralMotion()
  const canAnimate = typeof document !== 'undefined' && !document.hidden && typeof Element.prototype.animate === 'function'
  const panes = canAnimate ? Array.from(document.querySelectorAll<HTMLElement>(paneSelector)) : []
  const before = panes.map(node => node.getBoundingClientRect())
  flushSync(commit)
  if (!canAnimate) return
  const after = panes.map(node => node.getBoundingClientRect())
  const reduced = prefersReducedMotion()
  panes.forEach((node, index) => {
    const oldRect = before[index]
    const newRect = after[index]
    if (oldRect.width === newRect.width && oldRect.x === newRect.x) return
    const leaving = oldRect.width > 0 && newRect.width === 0
    if (!leaving && newRect.width === 0) return
    const wasInert = node.inert
    if (leaving) {
      node.dataset.paneLeaving = ''
      node.inert = true
      for (const [property, value] of Object.entries({ left: oldRect.left, top: oldRect.top, width: oldRect.width, height: oldRect.height })) {
        node.style.setProperty(`--leaving-${property}`, `${value}px`)
      }
    }
    const distance = node.id === 'sidebar-pane' ? -1 : 1
    const from = oldRect.width === 0 ? distance * newRect.width : leaving ? 0 : oldRect.left - newRect.left
    const to = leaving ? distance * oldRect.width : 0
    const animation = node.animate(reduced
      ? [{ opacity: leaving ? 1 : 0 }, { opacity: leaving ? 0 : 1 }]
      : [{ transform: `translateX(${from}px)`, opacity: leaving ? 1 : 0 }, { transform: `translateX(${to}px)`, opacity: leaving ? 0 : 1 }],
    { duration: reduced ? 120 : MOTION.durSlow, easing: reduced ? 'linear' : MOTION.easeStruct })
    animation.id = 'scry-pane'
    const unsubscribe = subscribeReducedMotion(value => { if (value) cancel() })
    const finish = (): void => {
      if (active.get(node) !== cancel) return
      active.delete(node)
      unsubscribe()
      if (leaving) {
        delete node.dataset.paneLeaving
        node.inert = wasInert
        for (const property of ['left', 'top', 'width', 'height']) node.style.removeProperty(`--leaving-${property}`)
      }
    }
    const cancel = (): void => { animation.cancel(); finish() }
    active.set(node, cancel)
    void animation.finished.then(finish, finish)
  })
}
