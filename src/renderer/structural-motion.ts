import { flushSync } from 'react-dom'
import { MOTION, prefersReducedMotion, subscribeReducedMotion } from './motion'

type StructuralKind = 'page' | 'session' | 'theme'
let cancelActive: (() => void) | null = null

export function cancelStructuralMotion(): void {
  cancelActive?.()
}

/** Live DOM only: commits and errors remain synchronous; captured-page hit testing is never used. */
export function runStructuralTransition(kind: StructuralKind, commit: () => void): void {
  cancelStructuralMotion()
  flushSync(commit)
  if (typeof document === 'undefined' || document.hidden || typeof Element.prototype.animate !== 'function') return
  // User-approved exception: theme changes immediately, without a whole-window snapshot.
  if (kind === 'theme') return
  const page = Array.from(document.querySelectorAll<HTMLElement>('.main-content')).find(node => node.getClientRects().length > 0)
  if (!page) return
  const reduced = prefersReducedMotion()
  const animation = page.animate(reduced || kind === 'session'
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }],
  { duration: reduced ? 120 : kind === 'page' ? 240 : 180, easing: reduced ? 'linear' : MOTION.easeOut })
  animation.id = 'scry-structure'
  const unsubscribe = subscribeReducedMotion(value => { if (value) cancel() })
  const finish = (): void => {
    if (cancelActive !== cancel) return
    cancelActive = null
    unsubscribe()
  }
  const cancel = (): void => { animation.cancel(); finish() }
  cancelActive = cancel
  void animation.finished.then(finish, finish)
}
