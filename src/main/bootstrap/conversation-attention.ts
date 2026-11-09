import type { BrowserWindow } from 'electron'
import { conversationAttentionKey } from '../../shared/session-attention'
import type { ConversationStore } from '../conversation-store'
import type { DockBadgeState } from '../dock-badge'
import type { TrustedRegistrar } from './agent-runtime-ipc'

/** Reading history is not proof of viewing it: previews and refreshes read it too. */
export function registerConversationAttention(deps: {
  handleTrusted: TrustedRegistrar
  conversationStore: () => ConversationStore
  resolveKnownProjectDirectory: (cwd: string) => string
  getWindow: () => Pick<BrowserWindow, 'isFocused'> | null
  clearLegacyFocus: () => void
  invalidateSessionHistoryLoad: (reason: string) => void
  dockBadge: DockBadgeState
}): () => void {
  let revision = 0
  let viewedKey: string | null = null
  const release = (): void => {
    revision += 1
    if (viewedKey) deps.dockBadge.unview(viewedKey)
    viewedKey = null
  }
  deps.handleTrusted('conversation:setViewed', async (_event, id: unknown) => {
    if (id !== null && (typeof id !== 'string' || !id.trim())) throw new Error('统一对话 ID 无效')
    release()
    const requestRevision = revision
    if (id === null) return
    const conversation = await deps.conversationStore().read(id as string)
    if (!conversation || conversation.deletion) throw new Error('统一对话不存在或已删除')
    deps.resolveKnownProjectDirectory(conversation.cwd)
    // A slow read for the previous view must not acknowledge the newly selected view.
    if (requestRevision !== revision) return
    deps.invalidateSessionHistoryLoad('managed conversation selected')
    deps.clearLegacyFocus()
    viewedKey = conversationAttentionKey(conversation.id)
    deps.dockBadge.view(viewedKey, Boolean(deps.getWindow()?.isFocused()))
  })
  return () => {
    release()
    // Renderer loss revokes viewing, not unread evidence, including pending native reads.
    deps.invalidateSessionHistoryLoad('renderer attention owner lost')
    deps.dockBadge.view(null, false)
  }
}
