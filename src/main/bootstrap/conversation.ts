import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentDataUpdated } from '../../shared/runtime'
import type { ProviderContext } from '../../shared/provider'
import type { createAppSessionStore } from '../app-store'
import type { ConversationStore, NativeSessionScope } from '../conversation-store'
import type { ConversationService } from '../conversation-service'
import type { ActiveRun } from '../../shared/trace'
import type { ContextAdmission } from '../context-admission'
import { parseConversationTarget } from '../conversation-request'
import { registerSideChatChannels } from './conversation-side-chat-channels'
import { parseConversationLegacySource, prepareConversationAdoption } from '../conversation-adoption'
import { deleteConversationHistory } from '../conversation-history'
import { registerConversationDeletionHandlers } from './conversation-delete'
import { resolveSessionRunIds } from '../db'
import type { DockBadgeState } from '../dock-badge'
import { conversationAttentionKey, sessionAttentionKey } from '../../shared/session-attention'

// The conversation channels the daemon serves its App as local ops (B4-L4). The App's
// window parts (following a send's run) are conversation-daemon-send.ts.
export type ConversationChannelListener = (event: unknown, ...args: never[]) => unknown

export interface ConversationTableDependencies {
  resolveKnownProjectDirectory: (cwd: string) => string
  providerContextKey: (providerId: ProviderContext['providerId'], cwd: string, agentProfileId?: string) => string
  contextAdmission: Pick<ContextAdmission, 'run' | 'runMany'>
  getStartupManagedRecovery: () => Promise<void>
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  conversationStore: () => ConversationStore
  getRuns: () => { unsettledStates: () => ActiveRun[] }
  providerRegistry: { continuationKey: (context: ProviderContext) => Promise<string> }
  providerSessionKey: (providerId: ProviderContext['providerId'], cwd: string, sessionId: string, agentProfileId?: string) => string
  assertLegacyConversationWriteAllowed: (scope: NativeSessionScope) => Promise<void>
  rememberProject: (cwd: string) => void
  deletingSessions: Set<string>
  adoptingSessionKeys: Set<string>
  conversationService: () => ConversationService
  invalidateSessionHistoryLoad: (reason: string) => void
  publishDataUpdated: (event: AgentDataUpdated) => void
  deleteOneSession: (request: Record<string, unknown>, options: Record<string, unknown>) => Promise<{ ok: boolean; deleted: string[]; retained: string[]; failed: Array<{ store: string; error: string }>; reason?: string }>
  resolveSessionRunIds: typeof resolveSessionRunIds
  deleteConversationHistory: typeof deleteConversationHistory
  appUserDataDir: string
  dockBadge: Pick<DockBadgeState, 'adopt'>
}

export function conversationChannelTable(deps: ConversationTableDependencies) {
  const handlers: Record<string, ConversationChannelListener> = {}
  // Collect instead of registering: main registers the table as IPC, the daemon serves it.
  const handle = (channel: string, listener: (event: unknown, ...args: any[]) => unknown): void => { handlers[channel] = listener }
  const { resolveKnownProjectDirectory, providerContextKey, contextAdmission, getStartupManagedRecovery, appSessionStore, conversationStore, getRuns, providerRegistry, deletingSessions, adoptingSessionKeys, conversationService, invalidateSessionHistoryLoad, publishDataUpdated, deleteOneSession, resolveSessionRunIds, deleteConversationHistory, appUserDataDir, providerSessionKey, assertLegacyConversationWriteAllowed, rememberProject } = deps
  async function adoptLegacyConversation(input: unknown, fingerprint?: string, requireHandoff = false) {
    const source = parseConversationLegacySource(input)
    source.cwd = resolveKnownProjectDirectory(source.cwd)
    return contextAdmission.run(providerContextKey(source.providerId, source.cwd, source.agentProfileId), async () => {
      await getStartupManagedRecovery()
      const catalog = appSessionStore().load().find(session => session.providerId === source.providerId &&
        session.agentProfileId === source.agentProfileId && session.cwd === source.cwd &&
        (session.externalSessionId === source.externalSessionId || session.sessionId === source.externalSessionId))
      if (!catalog) throw new Error('迁移源不属于已登记的 App 会话')
      source.externalSessionId = catalog.externalSessionId ?? catalog.sessionId
      const reservations = [source.externalSessionId, catalog.sessionId, catalog.runId].filter((id): id is string => Boolean(id))
        .map(id => providerSessionKey(source.providerId, source.cwd, id))
      // Reserve before the first asynchronous read so legacy metadata cannot change
      // between the catalog snapshot and durable ownership publication.
      for (const key of reservations) adoptingSessionKeys.add(key)
      try {
        const existing = (await conversationStore().list(source.cwd)).find(conversation => conversation.bindings.some(binding =>
          binding.providerId === source.providerId && binding.agentProfileId === source.agentProfileId && binding.nativeSessionId === source.externalSessionId))
        if (existing) {
          if (existing.deletion) throw new Error('旧会话正在删除或已删除，不能重新迁入')
          const original = existing.bindings[0]
          if (!existing.adoptionFingerprint || (fingerprint !== undefined && existing.adoptionFingerprint !== fingerprint) || original.providerId !== source.providerId ||
            original.agentProfileId !== source.agentProfileId || original.nativeSessionId !== source.externalSessionId) throw new Error('旧会话已归属统一对话，请打开其稳定条目')
          const adopted = (await conversationService().list(source.cwd)).find(conversation => conversation.id === existing.id)!
          if (fingerprint === undefined) return {
            source, fingerprint: existing.adoptionFingerprint, title: adopted.title,
            turnCount: adopted.turnCount, adoptedConversation: adopted
          }
          return adopted
        }
        await assertLegacyConversationWriteAllowed({ ...source, nativeSessionId: source.externalSessionId })
        if (getRuns().unsettledStates().some(run => run.providerId === source.providerId && run.agentProfileId === source.agentProfileId && run.cwd === source.cwd) ||
          [source.externalSessionId, catalog.sessionId, catalog.runId].some(id => id && deletingSessions.has(providerSessionKey(source.providerId, source.cwd, id)))) {
          throw new Error('源 Provider 仍在执行、保存证据或删除；请等待收敛后迁移')
        }
        const prepared = await prepareConversationAdoption(appUserDataDir, source, catalog, requireHandoff)
        if (fingerprint === undefined) return prepared.preview
        if (prepared.preview.fingerprint !== fingerprint) throw new Error('迁移源已变化，请重新预览；旧入口保留')
        const conversation = await conversationStore().create(source.cwd, prepared.seed)
        // The native row is hidden from now on, including under its app alias; a side chat
        // of it that is still running reports to the conversation's row instead.
        for (const sessionId of new Set([source.externalSessionId, catalog.sessionId])) {
          deps.dockBadge.adopt(sessionAttentionKey({ providerId: source.providerId, agentProfileId: source.agentProfileId,
            cwd: source.cwd, sessionId }), conversationAttentionKey(conversation.id))
        }
        invalidateSessionHistoryLoad('session adopted into logical conversation')
        publishDataUpdated({ kind: 'conversation_changed', conversationId: conversation.id })
        return (await conversationService().list(source.cwd)).find(item => item.id === conversation.id)!
      } finally { for (const key of reservations) adoptingSessionKeys.delete(key) }
    })
  }
  handle('conversation:fork', async (_event, request: unknown) => {
    await getStartupManagedRecovery()
    const result = await conversationService().fork(request)
    invalidateSessionHistoryLoad('logical conversation fork')
    publishDataUpdated({ kind: 'conversation_changed', conversationId: result.id })
    return result
  })
  handle('conversation:previewAdoption', async (_event, input: unknown, target?: unknown) => {
    const source = parseConversationLegacySource(input)
    source.cwd = resolveKnownProjectDirectory(source.cwd)
    if (target !== undefined) {
      const request = parseConversationTarget(target)
      // Both directions must remain usable before retiring the legacy entry.
      // These are read-only identity checks, never Provider launches.
      await providerRegistry.continuationKey(source)
      if (request.providerId !== source.providerId || request.agentProfileId !== source.agentProfileId) {
        await providerRegistry.continuationKey({ ...request, cwd: source.cwd })
      }
    }
    return adoptLegacyConversation(source, undefined, target !== undefined)
  })
  handle('conversation:adopt', (_event, source: unknown, fingerprint: unknown) => {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('迁移确认指纹无效')
    return adoptLegacyConversation(source, fingerprint)
  })
  // Deletion (with its side-chat cascade) is registered through the same collecting
  // `handle`, so main and the daemon serve it alike.
  const { prepareConversationDeletion, sideChatCascade } = registerConversationDeletionHandlers(handle, {
    providerContextKey, contextAdmission, getStartupManagedRecovery, appSessionStore, conversationStore,
    getRuns, invalidateSessionHistoryLoad, publishDataUpdated, deleteOneSession, resolveSessionRunIds, deleteConversationHistory,
    appUserDataDir
  })
  handle('conversation:update', async (_event, id: unknown, revision: unknown, change: unknown) => {
    if (typeof id !== 'string' || typeof revision !== 'number') throw new Error('对话管理请求无效')
    if (change && typeof change === 'object' && 'kind' in change && change.kind === 'archive') {
      const conversation = await conversationStore().read(id)
      const unsettled = new Set(getRuns().unsettledStates().map(run => run.runId))
      if (conversation?.turns.some(turn => unsettled.has(turn.runId))) {
        throw new Error('对话仍有运行或证据保存未收敛，不能存档或恢复')
      }
    }
    const result = await conversationService().update(id, revision, change)
    publishDataUpdated({ kind: 'conversation_changed', conversationId: id })
    return result
  })
  handle('conversation:create', async (_event, cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('统一对话工作区无效')
    const resolved = resolveKnownProjectDirectory(cwd)
    rememberProject(resolved)
    const conversation = await conversationService().create(resolved)
    publishDataUpdated({ kind: 'conversation_changed', conversationId: conversation.id })
    return conversation
  })
  handle('conversation:list', (_event, cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('统一对话工作区无效')
    return conversationService().list(resolveKnownProjectDirectory(cwd))
  })
  handle('conversation:read', (_event, id: unknown, beforeOrdinal?: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('统一对话 ID 无效')
    if (beforeOrdinal !== undefined && (!Number.isSafeInteger(beforeOrdinal) || Number(beforeOrdinal) < 0)) {
      throw new Error('统一对话分页游标无效')
    }
    return conversationService().read(id, beforeOrdinal as number | undefined)
  })
  handle('conversation:readItem', (_event, id: unknown, ref: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('统一对话 ID 无效')
    return conversationService().readItem(id, ref)
  })
  handle('conversation:preview', (_event, id: unknown, request: unknown) => {
    if (typeof id !== 'string' || !id.trim() || !request || typeof request !== 'object') throw new Error('统一对话预览请求无效')
    return conversationService().preview(id, request)
  })
  handle('conversation:send', (_event, request: unknown) => {
    if (!request || typeof request !== 'object') throw new Error('统一对话发送请求无效')
    return conversationService().send(request)
  })
  registerSideChatChannels(handle, {
    resolveKnownProjectDirectory, getStartupManagedRecovery, conversationStore, conversationService, publishDataUpdated,
    appSessionStore, contextAdmission, providerContextKey, providerSessionKey, deletingSessions
  })

  return { handlers, prepareConversationDeletion, sideChatCascade }
}

export interface ConversationBootstrapDependencies extends Omit<ConversationTableDependencies, 'publishDataUpdated'> {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  getWindow: () => BrowserWindow | null
}

/** The shared table on a trusted registrar, announcing writes to one window (tests drive the table this way). */
export function registerConversationHandlers(deps: ConversationBootstrapDependencies) {
  const publishDataUpdated = (event: AgentDataUpdated): void => { deps.getWindow()?.webContents.send('agent:dataUpdated', event) }
  const { handlers, prepareConversationDeletion, sideChatCascade } = conversationChannelTable({ ...deps, publishDataUpdated })
  for (const [channel, listener] of Object.entries(handlers)) deps.handleTrusted(channel, listener)
  return { prepareConversationDeletion, sideChatCascade }
}
