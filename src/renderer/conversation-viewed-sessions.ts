import { useEffect } from 'react'
import type { ConversationPage } from '@shared/conversation-api'
import { sessionAttentionKey } from '@shared/session-attention'

// A unified conversation shows one native session per Provider binding, and none of its
// runs is the window's focused run. Main only learns what is on screen if the view says
// so; otherwise every reply the conversation receives stays unread for good.

const MAX_KEYS = 16

/** The badge keys of the native sessions this page shows; live bindings first. */
export function conversationSessionKeys(page: Pick<ConversationPage, 'summary' | 'bindings'> | undefined): string[] {
  if (!page) return []
  const ordered = [...page.bindings].sort((a, b) => Number(Boolean(a.retiredReason)) - Number(Boolean(b.retiredReason)))
  const keys = new Set<string>()
  for (const binding of ordered) {
    if (!binding.nativeSessionId) continue
    keys.add(sessionAttentionKey({
      providerId: binding.providerId, agentProfileId: binding.agentProfileId,
      cwd: page.summary.cwd, sessionId: binding.nativeSessionId
    }))
  }
  return [...keys].slice(0, MAX_KEYS)
}

/**
 * Names the page's sessions as viewed while it is mounted; `main` when it fills the main
 * pane rather than sitting beside a session. Main clears them again when the window
 * regains focus, so nothing here listens for focus.
 */
export function useConversationSessionsViewed(
  conversationId: string, main: boolean, page: Pick<ConversationPage, 'summary' | 'bindings'> | undefined
): void {
  const signature = JSON.stringify(conversationSessionKeys(page))
  useEffect(() => {
    const view = window.scry.viewSessions
    const sessionKeys = JSON.parse(signature) as string[]
    if (!view || sessionKeys.length === 0) return
    const viewId = `${main ? 'main' : 'side'}:${conversationId}`
    void view({ viewId, main, sessionKeys }).catch(() => undefined)
    return () => { void view({ viewId, main, sessionKeys: [] }).catch(() => undefined) }
  }, [conversationId, main, signature])
}
