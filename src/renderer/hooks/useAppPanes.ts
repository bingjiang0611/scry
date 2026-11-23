import { useEffect } from 'react'
import { useResizablePane } from './useResizablePane'

// The App shell's two resizable panes and their bounds, kept together so the shell
// props and the panes cannot disagree about the limits.
export const APP_PANE_LIMITS = { sidebarMin: 190, sidebarMax: 260, panelMin: 360, panelMax: 960 } as const

export function useAppPanes() {
  const sidebarPane = useResizablePane({
    // The evidence-system shell deliberately resets the old 256px default once;
    // subsequent user resizing is still persisted under this geometry version.
    id: 'sidebar-evidence-system',
    defaultWidth: 230,
    min: APP_PANE_LIMITS.sidebarMin,
    max: APP_PANE_LIMITS.sidebarMax,
    side: 'left'
  })
  const surfacePane = useResizablePane({
    id: 'right-surface-panel',
    defaultWidth: 520,
    min: APP_PANE_LIMITS.panelMin,
    max: APP_PANE_LIMITS.panelMax,
    side: 'right'
  })
  return { sidebarPane, surfacePane }
}

/** Keep the daemon's detail subscription on the session the chat view shows (P4-4). */
export function useSessionDetailWatch(detailKey: string | undefined): void {
  useEffect(() => {
    if (!detailKey) return
    void window.scry.watchSessionDetail?.(detailKey)
    return () => { void window.scry.watchSessionDetail?.(null) }
  }, [detailKey])
}
