import type { AgentDataUpdated } from '../../shared/runtime'
import type { SideChatSource } from '../../shared/conversation'
import type { ConversationStore } from '../conversation-store'
import type { ConversationService } from '../conversation-service'
import { parseSideChatCreate, parseSideChatListRequest, parseSideChatSource } from '../conversation-request'

// Side-chat channels of the conversation table (bootstrap/conversation.ts), kept apart
// so each file stays inside the staged size budget. Registered through the same
// collecting `handle`, so main and the daemon serve them alike.
export function registerSideChatChannels(
  handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => void,
  deps: {
    resolveKnownProjectDirectory: (cwd: string) => string
    getStartupManagedRecovery: () => Promise<void>
    conversationStore: () => ConversationStore
    conversationService: () => ConversationService
    publishDataUpdated: (event: AgentDataUpdated) => void
  }
): void {
  const { resolveKnownProjectDirectory, getStartupManagedRecovery, conversationStore, conversationService, publishDataUpdated } = deps
  /**
   * Read-only source authorization. A managed (conversation) source must belong to
   * an authorized known project; a native source additionally has to match one
   * registered catalog session for its Provider/profile/cwd inside the service seam.
   * Listing keeps working from the children's own frozen provenance after the
   * original source record is gone.
   */
  async function authorizeSideChatSource(input: unknown, options: { requireSource?: boolean } = {}): Promise<SideChatSource> {
    const source = parseSideChatSource(input)
    if (source.kind === 'native-session') return { ...source, cwd: resolveKnownProjectDirectory(source.cwd) }
    const conversation = await conversationStore().read(source.conversationId)
    if (!conversation) {
      if (options.requireSource !== false) throw new Error('侧聊来源对话不存在或已删除；不会自动创建空快照')
      return source
    }
    // A deleted tombstone still names its project; capture itself refuses deletion.
    resolveKnownProjectDirectory(conversation.cwd)
    return source
  }
  handle('conversation:previewSideChat', async (_event, source: unknown, options?: unknown) => {
    await getStartupManagedRecovery()
    const authorized = await authorizeSideChatSource(source)
    return conversationService().previewSideChat(authorized, options)
  })
  handle('conversation:createSideChat', async (_event, request: unknown) => {
    // Shape first, then source authorization: an untyped request never reads the ledger.
    const parsed = parseSideChatCreate(request)
    const authorized = await authorizeSideChatSource(parsed.source)
    await getStartupManagedRecovery()
    const created = await conversationService().createSideChat({ ...parsed, source: authorized })
    publishDataUpdated({ kind: 'conversation_changed', conversationId: created.id })
    return created
  })
  handle('conversation:listSideChats', async (_event, request: unknown) => {
    const parsed = parseSideChatListRequest(request)
    await getStartupManagedRecovery()
    const authorized = await authorizeSideChatSource(parsed.source, { requireSource: false })
    return conversationService().listSideChats({ ...parsed, source: authorized })
  })
  /**
   * Read-only creation receipt lookup. The source is authorized exactly like list;
   * the service proves the found child's own provenance belongs to that source. A
   * not-found answer never creates a child and is not evidence about a lost IPC.
   */
  handle('conversation:findSideChatCommand', async (_event, source: unknown, commandId: unknown) => {
    if (typeof commandId !== 'string') throw new Error('侧聊创建命令无效')
    await getStartupManagedRecovery()
    const authorized = await authorizeSideChatSource(source, { requireSource: false })
    return conversationService().findSideChatCommand(authorized, commandId)
  })
  handle('conversation:readSideChatSnapshot', (_event, id: unknown, cursor?: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('统一对话 ID 无效')
    if (cursor !== undefined && typeof cursor !== 'string') throw new Error('侧聊正文游标无效')
    return conversationService().readSideChatSnapshot(id, cursor)
  })
}
