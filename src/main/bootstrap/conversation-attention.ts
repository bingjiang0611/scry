import type { BrowserWindow } from 'electron'
import { conversationAttentionKey } from '../../shared/session-attention'
import type { Conversation } from '../../shared/conversation'
import type { DockBadgeState } from '../dock-badge'
import type { TrustedRegistrar } from './agent-runtime-ipc'

/** Reading history is not proof of viewing it: previews and refreshes read it too. */
export function registerConversationAttention(deps: {
  handleTrusted: TrustedRegistrar
  /** The conversation's published ledger, read only (ConversationStore.read). */
  readConversation: (id: string) => Promise<Conversation | null>
  /** The daemon's known-project answer for the conversation's directory. */
  resolveKnownProjectDirectory: (cwd: string) => unknown
  getWindow: () => Pick<BrowserWindow, 'isFocused'> | null
  clearLegacyFocus: () => void
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
    const conversation = await deps.readConversation(id as string)
    if (!conversation || conversation.deletion) throw new Error('统一对话不存在或已删除')
    await deps.resolveKnownProjectDirectory(conversation.cwd)
    // A slow read for the previous view must not acknowledge the newly selected view.
    if (requestRevision !== revision) return
    deps.clearLegacyFocus()
    viewedKey = conversationAttentionKey(conversation.id)
    deps.dockBadge.view(viewedKey, Boolean(deps.getWindow()?.isFocused()))
  })
  return () => {
    release()
    // Renderer loss revokes viewing, not unread evidence.
    deps.dockBadge.view(null, false)
  }
}
