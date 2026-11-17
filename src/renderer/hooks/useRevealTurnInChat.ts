import { useCallback, type RefObject } from 'react'
import type { AppShellProps } from '../app-shell-types'

/**
 * Opens a turn in the chat transcript. When the primary pane is hidden (maximized or
 * narrow right panel) the timeline has no layout box for the navigation anchor, so the
 * right surface is hidden and the scroller focused first.
 */
export function useRevealTurnInChat({ primaryPaneVisible, handleRightSurfaceAction, openTurnInChat, scrollRef }: {
  primaryPaneVisible: boolean
  handleRightSurfaceAction: AppShellProps['handleRightSurfaceAction']
  openTurnInChat: AppShellProps['openTurnInChat']
  scrollRef: RefObject<HTMLDivElement>
}): AppShellProps['openTurnInChat'] {
  return useCallback<AppShellProps['openTurnInChat']>((...args) => {
    if (!primaryPaneVisible) {
      handleRightSurfaceAction({ type: 'hide' })
      scrollRef.current?.focus({ preventScroll: true })
    }
    openTurnInChat(...args)
  }, [primaryPaneVisible, handleRightSurfaceAction, openTurnInChat, scrollRef])
}
