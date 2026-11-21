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
  /**
   * Registers a listener for the daemon becoming ready again. A view that could not be
   * applied because the daemon did not answer is applied then, unless another view (or
   * none) was selected since.
   */
  onDaemonReady?: (listener: () => void) => void
}): () => void {
  let revision = 0
  let viewedKey: string | null = null
  // The view the window asked for while the daemon could not answer its project check.
  let deferred: { id: string; revision: number } | null = null
  const release = (): void => {
    revision += 1
    deferred = null
    if (viewedKey) deps.dockBadge.unview(viewedKey)
    viewedKey = null
  }
  const apply = async (id: string, requestRevision: number): Promise<void> => {
    const conversation = await deps.readConversation(id)
    if (!conversation || conversation.deletion) throw new Error('统一对话不存在或已删除')
    try {
      await deps.resolveKnownProjectDirectory(conversation.cwd)
    } catch (error) {
      // The daemon did not answer (unavailable, stopping, another version): the window
      // still shows this conversation, so its view must not silently stay released and
      // count its turns as unread. A refusal of the directory itself is final.
      if (requestRevision === revision && daemonDidNotAnswer(error)) deferred = { id, revision: requestRevision }
      throw error
    }
    // A slow read for the previous view must not acknowledge the newly selected view.
    if (requestRevision !== revision) return
    deps.clearLegacyFocus()
    viewedKey = conversationAttentionKey(conversation.id)
    deps.dockBadge.view(viewedKey, Boolean(deps.getWindow()?.isFocused()))
  }
  deps.onDaemonReady?.(() => {
    const pending = deferred
    if (!pending || pending.revision !== revision) return
    deferred = null
    apply(pending.id, pending.revision).catch((error: unknown) => {
      console.warn('[scry] conversation view could not be re-applied:', error)
    })
  })
  deps.handleTrusted('conversation:setViewed', async (_event, id: unknown) => {
    if (id !== null && (typeof id !== 'string' || !id.trim())) throw new Error('统一对话 ID 无效')
    release()
    if (id === null) return
    await apply(id as string, revision)
  })
  return () => {
    release()
    // Renderer loss revokes viewing, not unread evidence.
    deps.dockBadge.view(null, false)
  }
}

/** A daemon outcome (no answer, stopping, version mismatch, not connected yet), not a refusal. */
function daemonDidNotAnswer(error: unknown): boolean {
  const reason = (error as { reason?: unknown } | null)?.reason
  const code = typeof reason === 'string' ? reason : error instanceof Error ? error.message : ''
  return code.startsWith('daemon_')
}
