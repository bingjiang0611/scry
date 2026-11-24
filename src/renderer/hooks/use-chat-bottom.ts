import { useCallback, useRef } from 'react'
import { scrollChatToBottomIfNeeded } from '../chat-scroll'

/**
 * The "stick to the newest turn" latch. Extracted from the App wiring because every caller — a new
 * turn, a session switch, a restore — has to move the same three pieces together.
 */
export function useChatBottom(scrollRef: { current: HTMLDivElement | null }, cancel: () => void) {
  const shouldStickToBottomRef = useRef(true)
  const openingSessionBottomRef = useRef(false)
  const requestChatBottom = useCallback((preserveDuringSessionOpen = false): void => {
    cancel()
    if (preserveDuringSessionOpen) openingSessionBottomRef.current = true
    shouldStickToBottomRef.current = true
    scrollChatToBottomIfNeeded(scrollRef.current, true)
  }, [cancel, scrollRef])
  return { shouldStickToBottomRef, openingSessionBottomRef, requestChatBottom }
}
