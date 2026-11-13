import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefCallback } from 'react'
import { flushSync } from 'react-dom'
import { MOTION, prefersReducedMotion } from '../motion'

// Layout effects are the safe measurement point in the browser; the node-only
// unit harness renders without a DOM.
export const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export type PresenceState = 'enter' | 'exit'
export type PresenceCloseReason = 'button' | 'escape' | 'backdrop' | 'pointer' | 'replace' | 'confirm'

type PresenceOptions = {
  onClose: (reason: PresenceCloseReason) => void
  exitMs: number
  onExitStart?: () => void
}

// Extra allowance after exitMs + 40 for a late animation start on a frame-starved renderer.
// The packaged overlay check allows 450ms from close for a 160ms exit, so keep 50ms of slack
// for the late timer itself instead of spending the whole budget on the ceiling.
const exitCeilingMs = 200

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
    const fallbackMs = (prefersReducedMotion() ? MOTION.durationReduced : exitMs) + 40
    // An exit that never reports animationend still has to be removed. The ceiling is measured
    // from the close request, so following a late animation start can never postpone removal
    // past it; that keeps slow or frame-starved renderers bounded instead of hanging.
    const closeStart = Date.now()
    const armFallback = (): void => {
      clearTimeout(timer.current)
      const remaining = Math.max(0, Math.min(fallbackMs, closeStart + fallbackMs + exitCeilingMs - Date.now()))
      timer.current = setTimeout(finish, remaining)
    }
    const exitAnimationRunning = (): boolean => node?.getAnimations().some(animation => {
      const endTime = animation.effect?.getComputedTiming().endTime
      return Number.isFinite(endTime) && animation.playState === 'running'
    }) ?? false
    const onAnimationEnd = (event: AnimationEvent): void => {
      // One node can carry several exit animations. Finishing on the shortest one deleted the
      // node 53ms after its animation start on CI while a longer animation still ran.
      if (event.target === node && !exitAnimationRunning()) finish()
    }
    // A busy main thread can start the exit animation dozens of milliseconds after the state
    // change. Re-anchoring the fallback at the real animation start preserves the full exit
    // duration instead of deleting the node mid-animation, and animationend still wins first.
    const onAnimationStart = (event: AnimationEvent): void => {
      if (event.target === node) armFallback()
    }
    node?.addEventListener('animationend', onAnimationEnd)
    node?.addEventListener('animationstart', onAnimationStart)
    removeAnimationListener.current = () => {
      node?.removeEventListener('animationend', onAnimationEnd)
      node?.removeEventListener('animationstart', onAnimationStart)
    }
    // The fallback only runs when animationend never arrives (dropped or late compositor
    // frames). It has to leave real headroom for the animation itself: a software-composited
    // CI runner delivered animationstart ~165ms after the close and finished at ~296ms.
    armFallback()
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

/**
 * Presence driven by an `open` flag: callers keep setting `open` exactly as before
 * and only swap `open &&` for `present &&` when rendering, so the exit animation
 * still gets its DOM. Parent-driven closes are covered because the effect watches
 * the flag, not the event that changed it.
 */
export function useOpenPresence(open: boolean) {
  const [present, setPresent] = useState(open)
  const latestOpen = useRef(open)
  latestOpen.current = open
  const presence = usePresence({ exitMs: MOTION.durationExitSm, onClose: () => { if (!latestOpen.current) setPresent(false) } })
  useBrowserLayoutEffect(() => {
    if (open) { presence.reset(); setPresent(true) }
    else if (present) presence.requestClose('replace')
  }, [open])
  return { ...presence, present }
}
