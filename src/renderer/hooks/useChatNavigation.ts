import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { scrollChatTargetIntoView } from '../chat-scroll'

// A navigation request is distinct from its run ID: activating the same turn
// again must reposition it, even while its previous highlight is still visible.
export function useChatNavigation(scrollRef: RefObject<HTMLDivElement>, enabled: boolean, turnCount: number, scope?: string | null) {
  const [request, setRequest] = useState<{ runId: string; eventId?: string } | null>(null)
  const active = useRef(false)
  const navigate = useCallback((runId: string, eventId?: string): void => {
    active.current = true
    setRequest({ runId, eventId })
  }, [])

  const cancel = useCallback((): void => {
    active.current = false
    setRequest(null)
  }, [])
  useEffect(cancel, [scope, cancel])

  useEffect(() => {
    if (!enabled) { cancel(); return }
    if (!request) return
    const chat = scrollRef.current
    if (!chat) return
    let frame: number | null = null
    const align = (): void => {
      frame = null
      const turn = Array.from(chat.querySelectorAll<HTMLElement>('.turn[data-run-id]')).find(element => element.dataset.runId === request.runId)
      const event = request.eventId && turn
        ? Array.from(turn.querySelectorAll<HTMLElement>('[data-trace-event-id]')).find(element => element.dataset.traceEventId === request.eventId)
        : undefined
      const target = event ?? turn?.querySelector<HTMLElement>('.turn-user') ?? turn
      if (target) scrollChatTargetIntoView(chat, target, 'auto', event ? 'center' : 'start')
    }
    const schedule = (): void => {
      if (frame === null) frame = requestAnimationFrame(align)
    }
    // Virtual neighbors replace estimated heights after the first positioning.
    // Keep a bounded, layout-driven anchor instead of a stale smooth-scroll endpoint.
    const resize = new ResizeObserver(schedule)
    resize.observe(chat)
    for (const child of chat.children) resize.observe(child)
    const mutation = new MutationObserver(schedule)
    mutation.observe(chat, { childList: true, subtree: true })
    const clear = (): void => {
      cancel()
    }
    const keydown = (event: KeyboardEvent): void => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) clear()
    }
    chat.addEventListener('wheel', clear, { passive: true })
    chat.addEventListener('touchstart', clear, { passive: true })
    chat.addEventListener('pointerdown', clear)
    chat.addEventListener('keydown', keydown)
    schedule()
    // Preserve the existing highlight lifetime; never retain a permanent scroll lock.
    const timer = window.setTimeout(clear, 2200)
    return () => {
      resize.disconnect()
      mutation.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      chat.removeEventListener('wheel', clear)
      chat.removeEventListener('touchstart', clear)
      chat.removeEventListener('pointerdown', clear)
      chat.removeEventListener('keydown', keydown)
    }
  }, [request, enabled, turnCount, scrollRef, cancel])

  return { navigate, cancel, active, focusedTurnRunId: request?.runId ?? null }
}
