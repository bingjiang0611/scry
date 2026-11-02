const CHAT_BOTTOM_STICKY_PX = 32

interface ChatScrollTarget {
  getBoundingClientRect: () => { top: number; height?: number }
}

export function scrollChatTargetIntoView(
  chat: Pick<ChatScrollBox, 'scrollTop' | 'scrollTo' | 'clientHeight'> & ChatScrollTarget,
  target: ChatScrollTarget,
  behavior: ScrollBehavior = 'auto',
  align: 'start' | 'center' = 'start'
): void {
  const targetRect = target.getBoundingClientRect()
  const offset = align === 'center'
    ? Math.max(0, (chat.clientHeight - (targetRect.height ?? 0)) / 2)
    : 16
  const top = Math.max(0, chat.scrollTop + targetRect.top - chat.getBoundingClientRect().top - offset)
  chat.scrollTo({ top, behavior })
}

export interface ChatScrollBox {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
  scrollTo: (options: { top: number; behavior?: ScrollBehavior }) => void
}

export function chatBottomDistance(el: Pick<ChatScrollBox, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

export function isChatNearBottom(
  el: Pick<ChatScrollBox, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold = CHAT_BOTTOM_STICKY_PX
): boolean {
  return chatBottomDistance(el) <= threshold
}

export function scrollChatToBottomIfNeeded(
  el: ChatScrollBox | null,
  shouldStick: boolean,
  behavior: ScrollBehavior = 'auto'
): boolean {
  if (!el || !shouldStick) return false
  el.scrollTo({ top: el.scrollHeight, behavior })
  return true
}

export function chatBottomStickinessAfterScroll(
  el: Pick<ChatScrollBox, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  openingSession: boolean
): boolean {
  return openingSession || isChatNearBottom(el)
}

interface TranscriptGrowth {
  top: number
  height: number
  previousHeight: number
  firstMeasurement: boolean
  restoreAnchor: boolean
  edge: number
}

/**
 * Growth of a materialized turn that happened above the scroller's top edge, in pixels.
 *
 * The row above the reader is compensated so the rows below keep their position while
 * virtualized overscan materializes (`session-performance-ui-smoke` pins this for history).
 * The one exempt row is the turn an exact view restore just anchored: that turn sits
 * part-way above the edge and its growth is below the remembered offset, so compensating it
 * would move the reader off the very turn the restore placed (`side-chat-scroll-checks`
 * pins this for side chats).
 */
export function transcriptGrowthAboveEdge(
  { top, height, previousHeight, firstMeasurement, restoreAnchor, edge }: TranscriptGrowth
): number {
  if (restoreAnchor) return 0
  const anchorEdge = firstMeasurement ? top : top + previousHeight
  return anchorEdge < edge ? height - previousHeight : 0
}

/** Markdown, images and expanded evidence can resize after React commits. */
export function observeChatBottomLayout(el: HTMLElement, shouldStick: () => boolean): (() => void) | undefined {
  if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return
  let frame: number | null = null
  const pinAfterLayout = (): void => {
    if (!shouldStick() || frame != null) return
    frame = requestAnimationFrame(() => {
      frame = null
      scrollChatToBottomIfNeeded(el, shouldStick())
    })
  }
  const resizeObserver = new ResizeObserver(pinAfterLayout)
  resizeObserver.observe(el)
  for (const child of el.children) resizeObserver.observe(child)
  const mutationObserver = new MutationObserver((records) => {
    for (const record of records) {
      // Pagination must not retain removed turn elements through the observer.
      for (const child of record.removedNodes) if (child instanceof Element) resizeObserver.unobserve(child)
      for (const child of record.addedNodes) if (child instanceof Element) resizeObserver.observe(child)
    }
    pinAfterLayout()
  })
  mutationObserver.observe(el, { childList: true })
  return () => {
    mutationObserver.disconnect()
    resizeObserver.disconnect()
    if (frame != null) cancelAnimationFrame(frame)
  }
}
