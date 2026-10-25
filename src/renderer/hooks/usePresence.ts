import { useCallback, useEffect, useRef, useState, type RefCallback } from 'react'
import { flushSync } from 'react-dom'
import { prefersReducedMotion } from '../motion'

export type PresenceState = 'enter' | 'exit'
export type PresenceCloseReason = 'button' | 'escape' | 'backdrop' | 'pointer' | 'replace' | 'confirm'

type PresenceOptions = {
  onClose: (reason: PresenceCloseReason) => void
  exitMs: number
  onExitStart?: () => void
}

const pendingExits = new Set<() => void>()

export function flushPresenceExits(): void {
  for (const finish of [...pendingExits]) {
    if (pendingExits.has(finish)) finish()
  }
}

// Finish the old parent's close before the next trigger handler can reopen it.
// Batching false + true would otherwise leave the same exiting instance mounted.
function onNextInteraction(): void {
  flushSync(flushPresenceExits)
}

/** Retains only decorative exit DOM. Parent-driven unmounts always cancel it. */
export function usePresence({ onClose, exitMs, onExitStart }: PresenceOptions): {
  state: PresenceState
  ref: RefCallback<HTMLElement>
  requestClose: (reason: PresenceCloseReason) => void
  finishNow: () => void
  reset: () => void
} {
  const [state, setState] = useState<PresenceState>('enter')
  const nodeRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const onExitStartRef = useRef(onExitStart)
  const closeReason = useRef<PresenceCloseReason>('replace')
  const closing = useRef(false)
  const closed = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const removeAnimationListener = useRef<(() => void) | null>(null)
  const finishRef = useRef<() => void>(() => {})
  onCloseRef.current = onClose
  onExitStartRef.current = onExitStart

  const clearExit = useCallback((): void => {
    clearTimeout(timer.current)
    timer.current = undefined
    removeAnimationListener.current?.()
    removeAnimationListener.current = null
    if (pendingExits.delete(finishRef.current) && pendingExits.size === 0) {
      document.removeEventListener('pointerdown', onNextInteraction, true)
      document.removeEventListener('keydown', onNextInteraction, true)
    }
  }, [])
  const finish = useCallback((): void => {
    if (closed.current) return
    closed.current = true
    closing.current = false
    clearExit()
    onCloseRef.current(closeReason.current)
  }, [clearExit])
  finishRef.current = finish
  const ref = useCallback<RefCallback<HTMLElement>>(node => { nodeRef.current = node }, [])
  const requestClose = useCallback((reason: PresenceCloseReason): void => {
    if (closed.current || closing.current) return
    closeReason.current = reason
    closing.current = true
    const node = nodeRef.current
    // Retire hit testing before focus restoration can dispatch another event.
    if (node) { node.dataset.state = 'exit'; node.inert = true }
    setState('exit')
    onExitStartRef.current?.()
    const onAnimationEnd = (event: AnimationEvent): void => {
      if (event.target === node) finish()
    }
    node?.addEventListener('animationend', onAnimationEnd)
    removeAnimationListener.current = () => node?.removeEventListener('animationend', onAnimationEnd)
    timer.current = setTimeout(finish, (prefersReducedMotion() ? 120 : exitMs) + 80)
    if (pendingExits.size === 0) {
      document.addEventListener('pointerdown', onNextInteraction, true)
      document.addEventListener('keydown', onNextInteraction, true)
    }
    pendingExits.add(finish)
  }, [exitMs, finish])
  const reset = useCallback((): void => {
    clearExit()
    closeReason.current = 'replace'
    closed.current = false
    closing.current = false
    if (nodeRef.current) { nodeRef.current.inert = false; nodeRef.current.dataset.state = 'enter' }
    setState('enter')
  }, [clearExit])
  useEffect(() => {
    closed.current = false
    return () => { closed.current = true; clearExit() }
  }, [clearExit])
  return { state, ref, requestClose, finishNow: finish, reset }
}
