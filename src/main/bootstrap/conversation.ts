import type { BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { Conversation, ConversationDeletionResult } from '../../shared/conversation'
import type { ProviderContext } from '../../shared/provider'
import type { createAppSessionStore } from '../app-store'
import type { ConversationStore, NativeSessionScope } from '../conversation-store'
import type { ConversationService } from '../conversation-service'
import type { ActiveRun } from '../../shared/trace'
import type { ContextAdmission } from '../context-admission'
import { parseConversationTarget } from '../conversation-request'
import { parseSideChatCreate, parseSideChatListRequest, parseSideChatSource } from '../conversation-request'
import type { SideChatSource } from '../../shared/conversation'
import { parseConversationLegacySource, prepareConversationAdoption } from '../conversation-adoption'
import { deleteConversationHistory } from '../conversation-history'
import { liveConversationDeletionCatalog, planConversationDeletion, resolveConversationDeletionRuns } from '../conversation-deletion'
import { resolveSessionRunIds } from '../db'

export interface ConversationBootstrapDependencies {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
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
  getWindow: () => BrowserWindow | null
  deleteOneSession: (request: Record<string, unknown>, options: Record<string, unknown>) => Promise<{ ok: boolean; deleted: string[]; retained: string[]; failed: Array<{ store: string; error: string }>; reason?: string }>
  resolveSessionRunIds: typeof resolveSessionRunIds
  deleteConversationHistory: typeof deleteConversationHistory
  appUserDataDir: string
}

export function registerConversationHandlers(deps: ConversationBootstrapDependencies) {
  const { handleTrusted, resolveKnownProjectDirectory, providerContextKey, contextAdmission, getStartupManagedRecovery, appSessionStore, conversationStore, getRuns, providerRegistry, deletingSessions, adoptingSessionKeys, conversationService, invalidateSessionHistoryLoad, getWindow, deleteOneSession, resolveSessionRunIds, deleteConversationHistory, appUserDataDir, providerSessionKey, assertLegacyConversationWriteAllowed, rememberProject } = deps
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
        invalidateSessionHistoryLoad('session adopted into logical conversation')
        getWindow()?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: conversation.id })
        return (await conversationService().list(source.cwd)).find(item => item.id === conversation.id)!
      } finally { for (const key of reservations) adoptingSessionKeys.delete(key) }
    })
  }
  handleTrusted('conversation:fork', async (_event, request: unknown) => {
    await getStartupManagedRecovery()
    const result = await conversationService().fork(request)
    invalidateSessionHistoryLoad('logical conversation fork')
    getWindow()?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: result.id })
    return result
  })
  handleTrusted('conversation:previewAdoption', async (_event, input: unknown, target?: unknown) => {
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
  handleTrusted('conversation:adopt', (_event, source: unknown, fingerprint: unknown) => {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('迁移确认指纹无效')
    return adoptLegacyConversation(source, fingerprint)
  })
  function assertConversationDeletionIdle(conversation: Conversation): void {
    const runIds = new Set(conversation.turns.map(turn => turn.runId))
    if (getRuns().unsettledStates().some(run => runIds.has(run.runId))) throw new Error('对话仍有运行或证据保存未收敛，不能删除')
  }

  async function prepareConversationDeletion(conversation: Conversation) {
    const others = await conversationStore().list(conversation.cwd)
    const catalog = liveConversationDeletionCatalog(others, appSessionStore().load().filter(session => session.cwd === conversation.cwd))
    return resolveConversationDeletionRuns(planConversationDeletion(conversation, others, catalog), target =>
      resolveSessionRunIds({ providerId: target.providerId, cwd: conversation.cwd, externalSessionId: target.externalSessionId, runIds: new Set() }), others, catalog)
  }

  handleTrusted('conversation:previewDeletion', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('对话删除请求无效')
    await getStartupManagedRecovery()
    const conversation = await conversationStore().read(id)
    if (!conversation || (conversation.deletion?.status === 'complete' && !conversation.deletion.retainedCopies)) throw new Error('对话不存在或没有待核对的保留副本')
    assertConversationDeletionIdle(conversation)
    return prepareConversationDeletion(conversation)
  })
  handleTrusted('conversation:delete', async (_event, id: unknown, fingerprint: unknown): Promise<ConversationDeletionResult> => {
    if (typeof id !== 'string' || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('对话删除确认无效')
    return contextAdmission.run(`conversation-delete:${id}`, async () => {
      await getStartupManagedRecovery()
      const original = await conversationStore().read(id)
      if (!original) throw new Error('找不到统一对话')
      if (original.deletion?.status === 'complete') {
        if (original.deletion.fingerprint === fingerprint) return original.deletion.result!
        if (!original.deletion.retainedCopies) throw new Error('对话已删除，没有待核对的保留副本')
      }
      const { conversation, plan } = await contextAdmission.runMany(original.bindings.map(binding => providerContextKey(binding.providerId, original.cwd, binding.agentProfileId)), async () => {
        const conversation = (await conversationStore().read(id))!
        assertConversationDeletionIdle(conversation)
        const plan = await prepareConversationDeletion(conversation)
        if (plan.fingerprint !== fingerprint) throw new Error('删除范围已变化，请重新预览；本次请求未执行清理')
        await conversationStore().beginDeletion(id, plan.revision, fingerprint, plan.reclaim === true)
        return { conversation, plan }
      })
      const result: ConversationDeletionResult = {
        ok: false, deleted: [], retained: [
          'workspace .scry/ canonical turn evidence', 'Provider-native session transcript/history',
          'unattributed provider billing aggregates', 'unsent renderer composer drafts',
          'logical ownership tombstone (IDs, hashes and deletion receipt)'
        ], failed: []
      }
      for (const target of plan.targets) {
        const scope = `${target.providerId}/${target.agentProfileId ?? 'default'}/${target.externalSessionId}`
        if (target.sharedWith.length) {
          result.retained.push(`shared Scry copies: ${scope} (${target.sharedWith.join(', ')})`)
          continue
        }
        try {
          const receipt = await deleteOneSession({ ...target, cwd: conversation.cwd }, {
            confirm: false, notifyFailure: false, conversationId: id, runIds: target.runIds
          })
          result.deleted.push(...receipt.deleted.map(store => `${scope}: ${store}`))
          result.retained.push(...receipt.retained)
          result.failed.push(...receipt.failed.map(failure => ({ ...failure, store: `${scope}: ${failure.store}` })))
          if (!receipt.ok && !receipt.failed.length) result.failed.push({ store: scope, error: receipt.reason ?? '删除结果未确认' })
        } catch (error) { result.failed.push({ store: scope, error: error instanceof Error ? error.message : String(error) }) }
      }
      try {
        await deleteConversationHistory(appUserDataDir, conversation)
        result.deleted.push('frozen handoff bodies')
      } catch (error) { result.failed.push({ store: 'frozen handoff bodies', error: error instanceof Error ? error.message : String(error) }) }
      result.retained = [...new Set(result.retained)]
      result.ok = result.failed.length === 0
      if (!result.ok) result.reason = 'partial_failure'
      await conversationStore().finishDeletion(id, fingerprint, result, plan.targets.some(target => target.sharedWith.length > 0))
      invalidateSessionHistoryLoad('logical conversation deletion')
      getWindow()?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: id })
      return result
    })
  })
  handleTrusted('conversation:update', async (_event, id: unknown, revision: unknown, change: unknown) => {
    if (typeof id !== 'string' || typeof revision !== 'number') throw new Error('对话管理请求无效')
    if (change && typeof change === 'object' && 'kind' in change && change.kind === 'archive') {
      const conversation = await conversationStore().read(id)
      const unsettled = new Set(getRuns().unsettledStates().map(run => run.runId))
      if (conversation?.turns.some(turn => unsettled.has(turn.runId))) {
        throw new Error('对话仍有运行或证据保存未收敛，不能存档或恢复')
      }
    }
    const result = await conversationService().update(id, revision, change)
    getWindow()?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: id })
    return result
  })
  handleTrusted('conversation:create', async (_event, cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('统一对话工作区无效')
    const resolved = resolveKnownProjectDirectory(cwd)
    rememberProject(resolved)
    const conversation = await conversationService().create(resolved)
    getWindow()?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: conversation.id })
    return conversation
  })
  handleTrusted('conversation:list', (_event, cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('统一对话工作区无效')
    return conversationService().list(resolveKnownProjectDirectory(cwd))
  })
  handleTrusted('conversation:read', (_event, id: unknown, beforeOrdinal?: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('统一对话 ID 无效')
    if (beforeOrdinal !== undefined && (!Number.isSafeInteger(beforeOrdinal) || Number(beforeOrdinal) < 0)) {
      throw new Error('统一对话分页游标无效')
    }
    return conversationService().read(id, beforeOrdinal as number | undefined)
  })
  handleTrusted('conversation:readItem', (_event, id: unknown, ref: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('统一对话 ID 无效')
    return conversationService().readItem(id, ref)
  })
  handleTrusted('conversation:preview', (_event, id: unknown, request: unknown) => {
    if (typeof id !== 'string' || !id.trim() || !request || typeof request !== 'object') throw new Error('统一对话预览请求无效')
    return conversationService().preview(id, request)
  })
  handleTrusted('conversation:send', (_event, request: unknown) => {
    if (!request || typeof request !== 'object') throw new Error('统一对话发送请求无效')
    return conversationService().send(request)
  })
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
  handleTrusted('conversation:previewSideChat', async (_event, source: unknown, options?: unknown) => {
    await getStartupManagedRecovery()
    const authorized = await authorizeSideChatSource(source)
    return conversationService().previewSideChat(authorized, options)
  })
  handleTrusted('conversation:createSideChat', async (_event, request: unknown) => {
    // Shape first, then source authorization: an untyped request never reads the ledger.
    const parsed = parseSideChatCreate(request)
    const authorized = await authorizeSideChatSource(parsed.source)
    await getStartupManagedRecovery()
    const created = await conversationService().createSideChat({ ...parsed, source: authorized })
    getWindow()?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: created.id })
    return created
  })
  handleTrusted('conversation:listSideChats', async (_event, request: unknown) => {
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
  handleTrusted('conversation:findSideChatCommand', async (_event, source: unknown, commandId: unknown) => {
    if (typeof commandId !== 'string') throw new Error('侧聊创建命令无效')
    await getStartupManagedRecovery()
    const authorized = await authorizeSideChatSource(source, { requireSource: false })
    return conversationService().findSideChatCommand(authorized, commandId)
  })
  handleTrusted('conversation:readSideChatSnapshot', (_event, id: unknown, cursor?: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('统一对话 ID 无效')
    if (cursor !== undefined && typeof cursor !== 'string') throw new Error('侧聊正文游标无效')
    return conversationService().readSideChatSnapshot(id, cursor)
  })

  return { prepareConversationDeletion }
}
