import { useEffect } from 'react'

/** Only the displayed primary conversation owns this view, never history prefetches. */
export function useConversationAttention(conversationId: string | undefined): void {
  useEffect(() => {
    const report = (id: string | null): void => {
      // Attention is an observation, never a reason to break the shell: a bridge without
      // this method (an older preload, or an isolated renderer fixture) has nothing to
      // report to. Calling it anyway threw during render and blanked the whole window.
      const api = window.scry?.conversations
      if (typeof api?.setViewed !== 'function') return
      void api.setViewed(id)
        .catch(error => console.warn('[scry] conversation attention update failed:', error))
    }
    // A renderer reload does not run the previous React tree's cleanup.
    if (!conversationId) { report(null); return }
    const update = (): void => report(document.hidden ? null : conversationId)
    update()
    // Native window focus already reconciles DockBadgeState; do not read the ledger twice.
    document.addEventListener('visibilitychange', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      report(null)
    }
  }, [conversationId])
}
