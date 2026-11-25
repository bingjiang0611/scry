import type { AgentDataUpdated } from '../../shared/runtime'
import type { ProviderContext } from '../../shared/provider'
import type { createAppSessionStore } from '../app-store'
import type { ContextAdmission } from '../context-admission'
import type { SideChatSource } from '../../shared/conversation'
import type { ConversationStore } from '../conversation-store'
import type { ConversationService } from '../conversation-service'
import { parseSideChatCreate, parseSideChatListRequest, parseSideChatSource } from '../conversation-request'

// collecting `handle`, so main and the daemon serve them alike.
export function registerSideChatChannels(
  handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => void,
  deps: {
    resolveKnownProjectDirectory: (cwd: string) => string
    getStartupManagedRecovery: () => Promise<void>
    conversationStore: () => ConversationStore
    conversationService: () => ConversationService
    publishDataUpdated: (event: AgentDataUpdated) => void
    appSessionStore: () => Pick<ReturnType<typeof createAppSessionStore>, 'load'>
    contextAdmission: Pick<ContextAdmission, 'run'>
    providerContextKey: (providerId: ProviderContext['providerId'], cwd: string, agentProfileId?: string) => string
    providerSessionKey: (providerId: ProviderContext['providerId'], cwd: string, sessionId: string, agentProfileId?: string) => string
    deletingSessions: ReadonlySet<string>
  }
): void {
  const { resolveKnownProjectDirectory, getStartupManagedRecovery, conversationStore, conversationService, publishDataUpdated,
    appSessionStore, contextAdmission, providerContextKey, providerSessionKey, deletingSessions } = deps
  function nativeSourceDeleting(source: Extract<SideChatSource, { kind: 'native-session' }>): boolean {
    // A delete reserves the alias it was asked for; the source may name either alias.
    const row = appSessionStore().load().find(session => session.providerId === source.providerId &&
      session.agentProfileId === source.agentProfileId && session.cwd === source.cwd &&
      (session.externalSessionId === source.nativeSessionId || session.sessionId === source.nativeSessionId))
    return [source.nativeSessionId, row?.externalSessionId, row?.sessionId, row?.runId]
      .some(id => id && deletingSessions.has(providerSessionKey(source.providerId, source.cwd, id, source.agentProfileId)))
  }
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
    // In flight from before the first wait: a read-back during authorization or startup
    // recovery must not answer not-found for a create that is about to publish.
    return conversationService().trackSideChatCreate(parsed.commandId, async () => {
      const authorized = await authorizeSideChatSource(parsed.source)
      await getStartupManagedRecovery()
      const publish = () => conversationService().createSideChat({ ...parsed, source: authorized })
      // A Provider session's delete reserves itself and counts its side chats under this
      // admission. Publishing under it too means a child is either counted by that delete
      // or refused here, never left behind with no source panel to open it from.
      const created = authorized.kind === 'native-session'
        ? await contextAdmission.run(providerContextKey(authorized.providerId, authorized.cwd, authorized.agentProfileId), async () => {
          if (nativeSourceDeleting(authorized)) throw new Error('侧聊来源会话正在删除，不能创建侧边会话')
          return publish()
        })
        : await publish()
      publishDataUpdated({ kind: 'conversation_changed', conversationId: created.id })
      return created
    })
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
