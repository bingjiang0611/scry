import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { usePresence, flushPresenceExits, type PresenceCloseReason } from '../hooks/usePresence'

type ModalEntry = { element: HTMLElement; active: boolean; requestClose: (reason: PresenceCloseReason) => void }
const activeModals: ModalEntry[] = []
function topModal(): ModalEntry | undefined {
  for (let index = activeModals.length - 1; index >= 0; index--) {
    if (activeModals[index].active) return activeModals[index]
  }
  return undefined
}

/** Explicit close-button routing; the primitive keeps its ordinary click contract. */
export function requestModalClose(reason: PresenceCloseReason = 'button'): void {
  topModal()?.requestClose(reason)
}

export function ModalFrame({
  labelledBy,
  initialFocusRef,
  className,
  onClose,
  closeDisabled = false,
  canClose,
  children
}: {
  labelledBy: string
  initialFocusRef?: RefObject<HTMLElement>
  className?: string
  onClose: (reason: PresenceCloseReason) => void
  closeDisabled?: boolean
  canClose?: (reason: PresenceCloseReason) => boolean
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<(() => void) | null>(null)
  const entryRef = useRef<ModalEntry | null>(null)
  const frameRef = useRef<number>()
  const disabledRef = useRef(closeDisabled)
  const canCloseRef = useRef(canClose)
  disabledRef.current = closeDisabled
  canCloseRef.current = canClose
  const presence = usePresence({
    onClose,
    exitMs: 160,
    onExitStart: () => {
      if (entryRef.current) entryRef.current.active = false
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
      restoreRef.current?.()
    }
  })
  const requestClose = useCallback((reason: PresenceCloseReason): void => {
    if (!disabledRef.current && canCloseRef.current?.(reason) !== false) presence.requestClose(reason)
  }, [presence.requestClose])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    flushPresenceExits()
    const entry: ModalEntry = { element: dialog, active: true, requestClose }
    entryRef.current = entry
    activeModals.push(entry)
    return () => {
      const index = activeModals.indexOf(entry)
      if (index >= 0) activeModals.splice(index, 1)
      entryRef.current = null
    }
  }, [requestClose])

  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let restored = false
    const focusable = (): HTMLElement[] => [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? [])]
    let initialTarget: HTMLElement | null = null
    const isTop = (): boolean => topModal() === entryRef.current
    const focusInitial = (): void => {
      if (!isTop()) return
      const requested = initialFocusRef?.current
      const target = requested && !requested.matches(':disabled') ? requested : focusable()[0] ?? dialogRef.current
      if (!initialTarget) initialTarget = target ?? null
      target?.focus({ preventScroll: true })
    }
    const restoreFocus = (): void => {
      if (restored) return
      restored = true
      if (restore?.isConnected) restore.focus({ preventScroll: true })
    }
    restoreRef.current = restoreFocus
    focusInitial()
    frameRef.current = window.requestAnimationFrame(() => {
      const active = document.activeElement
      if (dialogRef.current?.contains(active) && active !== initialTarget) return
      focusInitial()
    })
    const onFocusIn = (): void => {
      if (!isTop()) return
      if (dialogRef.current && !dialogRef.current.contains(document.activeElement)) focusInitial()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isTop() || !dialogRef.current) return
      if (event.key === 'Escape') {
        event.preventDefault()
        requestClose('escape')
        return
      }
      if (event.key !== 'Tab') return
      const controls = focusable()
      if (controls.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown)
      restoreRef.current = null
      if (!restored && restore?.isConnected) restore.focus({ preventScroll: true })
    }
  }, [initialFocusRef, requestClose])

  const content = (
    <div
      ref={presence.ref}
      className="modal-overlay"
      data-state={presence.state}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          // The backdrop's native mousedown must not clear the focus restored below.
          event.preventDefault()
          requestClose('backdrop')
        }
      }}
    >
      <div ref={dialogRef} className={`modal${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
        {children}
      </div>
    </div>
  )
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}
