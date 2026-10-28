import type { IpcMainInvokeEvent } from 'electron'
import type { DeleteSessionResult, ProviderContext, ProviderId, SessionProviderId } from '../shared/provider'
import type { Conversation, ConversationDeletionResult } from '../shared/conversation'
import type { ConversationSubmissionResult } from '../shared/conversation-api'
import { parseDesktopConversationSubmission } from './desktop-conversation-submission'
import type { AppSession } from './app-store'
import type { ConversationService } from './conversation-service'
import type { ConversationStore, NativeSessionScope } from './conversation-store'
import { liveConversationDeletionCatalog, planConversationDeletion, resolveConversationDeletionRuns } from './conversation-deletion'
import { parseConversationLegacySource, prepareConversationAdoption } from './conversation-adoption'
import { deleteConversationHistory } from './conversation-history'
import { resolveSessionRunIds } from './db'
import { parseConversationTarget } from './conversation-service'
import type { TaskCommandCatalog } from '../shared/task-command'
import { taskSubmissionCopy } from '../shared/constants/copy'

export type SessionDeletionRequest = Omit<ProviderContext, 'providerId'> & { providerId: SessionProviderId }

type ConversationRunSnapshot = {
  runId: string
  providerId?: ProviderId
  agentProfileId?: string
  cwd?: string
}

type DeleteOneSession = (
  request: SessionDeletionRequest,
  options: { confirm: boolean; notifyFailure: boolean; conversationId?: string; runIds?: readonly string[] }
) => Promise<DeleteSessionResult>

export interface ConversationAppIpcDependencies {
  register: <TArgs extends unknown[], TResult>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult
  ) => void
  service: () => ConversationService
  submitDesktopTask: (request: unknown) => ReturnType<ConversationService['send']>
  submitDesktopConversation: (conversation: Conversation, request: ReturnType<typeof parseDesktopConversationSubmission>) => Promise<ConversationSubmissionResult>
  listDesktopTaskCommands: (conversation: Pick<Conversation, 'id' | 'cwd'>, request: unknown) => Promise<TaskCommandCatalog>
  store: () => ConversationStore
  adoptingSessionKeys: Set<string>
  getStartupManagedRecovery: () => Promise<void>
  resolveKnownProjectDirectory: (cwd: string) => string
  resolveKnownProjectDirectoryAsync: (cwd: string) => Promise<string>
  providerContextKey: (providerId: ProviderId, cwd: string, agentProfileId?: string) => string
  providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, agentProfileId?: string) => string
  providerContinuationKey: (context: ProviderContext) => Promise<string>
  runInContext: <T>(key: string, action: () => Promise<T>) => Promise<T>
  runInContexts: <T>(keys: readonly string[], action: () => Promise<T>) => Promise<T>
  unsettledRuns: () => ReadonlyArray<ConversationRunSnapshot>
  loadAppSessions: () => AppSession[]
  assertLegacyConversationWriteAllowed: (scope: NativeSessionScope, deletion?: { ownerId?: string }) => Promise<void>
  isDeletingSession: (key: string) => boolean
  userData: () => string
  rememberProject: (cwd: string) => void
  invalidateSessionHistoryLoad: (reason: string) => void
  sendConversationChanged: (conversationId: string) => void
  deleteOneSession: DeleteOneSession
}

export function registerConversationIpc(deps: ConversationAppIpcDependencies) {
  async function adoptLegacyConversation(input: unknown, fingerprint?: string, requireHandoff = false) {
    const source = parseConversationLegacySource(input)
    source.cwd = deps.resolveKnownProjectDirectory(source.cwd)
    return deps.runInContext(deps.providerContextKey(source.providerId, source.cwd, source.agentProfileId), async () => {
      await deps.getStartupManagedRecovery()
      const catalog = deps.loadAppSessions().find(session => session.providerId === source.providerId &&
        session.agentProfileId === source.agentProfileId && session.cwd === source.cwd &&
        (session.externalSessionId === source.externalSessionId || session.sessionId === source.externalSessionId))
      if (!catalog) throw new Error('迁移源不属于已登记的 App 会话')
      source.externalSessionId = catalog.externalSessionId ?? catalog.sessionId
      const reservations = [source.externalSessionId, catalog.sessionId, catalog.runId].filter((id): id is string => Boolean(id))
        .map(id => deps.providerSessionKey(source.providerId, source.cwd, id))
      // Reserve before the first asynchronous read so legacy metadata cannot change
      // between the catalog snapshot and durable ownership publication.
      for (const key of reservations) deps.adoptingSessionKeys.add(key)
      try {
        const existing = (await deps.store().list(source.cwd)).find(conversation => conversation.bindings.some(binding =>
          binding.providerId === source.providerId && binding.agentProfileId === source.agentProfileId && binding.nativeSessionId === source.externalSessionId))
        if (existing) {
          if (existing.deletion) throw new Error('旧会话正在删除或已删除，不能重新迁入')
          const original = existing.bindings[0]
          if (!existing.adoptionFingerprint || (fingerprint !== undefined && existing.adoptionFingerprint !== fingerprint) || original.providerId !== source.providerId ||
            original.agentProfileId !== source.agentProfileId || original.nativeSessionId !== source.externalSessionId) throw new Error('旧会话已归属统一对话，请打开其稳定条目')
          const adopted = (await deps.service().list(source.cwd)).find(conversation => conversation.id === existing.id)!
          if (fingerprint === undefined) return { source, fingerprint: existing.adoptionFingerprint, title: adopted.title,
            turnCount: adopted.turnCount, adoptedConversation: adopted }
          return adopted
        }
        await deps.assertLegacyConversationWriteAllowed({ ...source, nativeSessionId: source.externalSessionId })
        if (deps.unsettledRuns().some(run => run.providerId === source.providerId && run.agentProfileId === source.agentProfileId && run.cwd === source.cwd) ||
          [source.externalSessionId, catalog.sessionId, catalog.runId].some(id => id && deps.isDeletingSession(deps.providerSessionKey(source.providerId, source.cwd, id)))) {
          throw new Error('源 Provider 仍在执行、保存证据或删除；请等待收敛后迁移')
        }
        const prepared = await prepareConversationAdoption(deps.userData(), source, catalog, requireHandoff)
        if (fingerprint === undefined) return prepared.preview
        if (prepared.preview.fingerprint !== fingerprint) throw new Error('迁移源已变化，请重新预览；旧入口保留')
        const conversation = await deps.store().create(source.cwd, prepared.seed)
        deps.invalidateSessionHistoryLoad('session adopted into logical conversation')
        deps.sendConversationChanged(conversation.id)
        return (await deps.service().list(source.cwd)).find(item => item.id === conversation.id)!
      } finally { for (const key of reservations) deps.adoptingSessionKeys.delete(key) }
    })
  }

  deps.register('conversation:fork', async (_event, request: unknown) => {
    await deps.getStartupManagedRecovery()
    const result = await deps.service().fork(request)
    deps.invalidateSessionHistoryLoad('logical conversation fork')
    deps.sendConversationChanged(result.id)
    return result
  })
  deps.register('conversation:previewAdoption', async (_event, input: unknown, target?: unknown) => {
    const source = parseConversationLegacySource(input)
    source.cwd = deps.resolveKnownProjectDirectory(source.cwd)
    if (target !== undefined) {
      const request = parseConversationTarget(target)
      // Both directions must remain usable before retiring the legacy entry.
      // These are read-only identity checks, never Provider launches.
      await deps.providerContinuationKey(source)
      if (request.providerId !== source.providerId || request.agentProfileId !== source.agentProfileId) {
        await deps.providerContinuationKey({ ...request, cwd: source.cwd })
      }
    }
    return adoptLegacyConversation(source, undefined, target !== undefined)
  })
  deps.register('conversation:adopt', (_event, source: unknown, fingerprint: unknown) => {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('迁移确认指纹无效')
    return adoptLegacyConversation(source, fingerprint)
  })

  function assertConversationDeletionIdle(conversation: Conversation): void {
    const runIds = new Set(conversation.turns.map(turn => turn.runId))
    if (deps.unsettledRuns().some(run => runIds.has(run.runId))) throw new Error('对话仍有运行或证据保存未收敛，不能删除')
  }

  async function prepareConversationDeletion(conversation: Conversation) {
    const others = await deps.store().list(conversation.cwd)
    const catalog = liveConversationDeletionCatalog(others, deps.loadAppSessions().filter(session => session.cwd === conversation.cwd))
    return resolveConversationDeletionRuns(planConversationDeletion(conversation, others, catalog), target =>
      resolveSessionRunIds({ providerId: target.providerId, cwd: conversation.cwd, externalSessionId: target.externalSessionId, runIds: new Set() }), others, catalog)
  }

  deps.register('conversation:previewDeletion', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('对话删除请求无效')
    await deps.getStartupManagedRecovery()
    const conversation = await deps.store().read(id)
    if (!conversation || (conversation.deletion?.status === 'complete' && !conversation.deletion.retainedCopies)) throw new Error('对话不存在或没有待核对的保留副本')
    assertConversationDeletionIdle(conversation)
    return prepareConversationDeletion(conversation)
  })
  deps.register('conversation:delete', async (_event, id: unknown, fingerprint: unknown): Promise<ConversationDeletionResult> => {
    if (typeof id !== 'string' || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('对话删除确认无效')
    return deps.runInContext(`conversation-delete:${id}`, async () => {
      await deps.getStartupManagedRecovery()
      const original = await deps.store().read(id)
      if (!original) throw new Error('找不到统一对话')
      if (original.deletion?.status === 'complete') {
        if (original.deletion.fingerprint === fingerprint) return original.deletion.result!
        if (!original.deletion.retainedCopies) throw new Error('对话已删除，没有待核对的保留副本')
      }
      const { conversation, plan } = await deps.runInContexts(original.bindings.map(binding => deps.providerContextKey(binding.providerId, original.cwd, binding.agentProfileId)), async () => {
        const conversation = (await deps.store().read(id))!
        assertConversationDeletionIdle(conversation)
        const plan = await prepareConversationDeletion(conversation)
        if (plan.fingerprint !== fingerprint) throw new Error('删除范围已变化，请重新预览；本次请求未执行清理')
        await deps.store().beginDeletion(id, plan.revision, fingerprint, plan.reclaim === true)
        return { conversation, plan }
      })
      const result: ConversationDeletionResult = { ok: false, deleted: [], retained: [
        'workspace .scry/ canonical turn evidence', 'Provider-native session transcript/history',
        'unattributed provider billing aggregates', 'unsent renderer composer drafts',
        'logical ownership tombstone (IDs, hashes and deletion receipt)'
      ], failed: [] }
      for (const target of plan.targets) {
        const scope = `${target.providerId}/${target.agentProfileId ?? 'default'}/${target.externalSessionId}`
        if (target.sharedWith.length) {
          result.retained.push(`shared Scry copies: ${scope} (${target.sharedWith.join(', ')})`)
          continue
        }
        try {
          const receipt = await deps.deleteOneSession({ ...target, cwd: conversation.cwd }, {
            confirm: false, notifyFailure: false, conversationId: id, runIds: target.runIds
          })
          result.deleted.push(...receipt.deleted.map(store => `${scope}: ${store}`))
          result.retained.push(...receipt.retained)
          result.failed.push(...receipt.failed.map(failure => ({ ...failure, store: `${scope}: ${failure.store}` })))
          if (!receipt.ok && !receipt.failed.length) result.failed.push({ store: scope, error: receipt.reason ?? '删除结果未确认' })
        } catch (error) { result.failed.push({ store: scope, error: error instanceof Error ? error.message : String(error) }) }
      }
      try {
        await deleteConversationHistory(deps.userData(), conversation)
        result.deleted.push('frozen handoff bodies')
      } catch (error) { result.failed.push({ store: 'frozen handoff bodies', error: error instanceof Error ? error.message : String(error) }) }
      result.retained = [...new Set(result.retained)]
      result.ok = result.failed.length === 0
      if (!result.ok) result.reason = 'partial_failure'
      await deps.store().finishDeletion(id, fingerprint, result, plan.targets.some(target => target.sharedWith.length > 0))
      deps.invalidateSessionHistoryLoad('logical conversation deletion')
      deps.sendConversationChanged(id)
      return result
    })
  })
  deps.register('conversation:update', async (_event, id: unknown, revision: unknown, change: unknown) => {
    if (typeof id !== 'string' || typeof revision !== 'number') throw new Error('对话管理请求无效')
    if (change && typeof change === 'object' && 'kind' in change && change.kind === 'archive') {
      const conversation = await deps.store().read(id)
      const unsettled = new Set(deps.unsettledRuns().map(run => run.runId))
      if (conversation?.turns.some(turn => unsettled.has(turn.runId))) {
        throw new Error('对话仍有运行或证据保存未收敛，不能存档或恢复')
      }
    }
    const result = await deps.service().update(id, revision, change)
    deps.sendConversationChanged(id)
    return result
  })
  deps.register('conversation:create', async (_event, cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('统一对话工作区无效')
    const resolved = deps.resolveKnownProjectDirectory(cwd)
    deps.rememberProject(resolved)
    const conversation = await deps.service().create(resolved)
    deps.sendConversationChanged(conversation.id)
    return conversation
  })
  deps.register('conversation:list', (_event, cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('统一对话工作区无效')
    return deps.service().list(deps.resolveKnownProjectDirectory(cwd))
  })
  deps.register('conversation:read', (_event, id: unknown, beforeOrdinal?: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('统一对话 ID 无效')
    if (beforeOrdinal !== undefined && (!Number.isSafeInteger(beforeOrdinal) || Number(beforeOrdinal) < 0)) {
      throw new Error('统一对话分页游标无效')
    }
    return deps.service().read(id, beforeOrdinal as number | undefined)
  })
  deps.register('conversation:readItem', (_event, id: unknown, ref: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('统一对话 ID 无效')
    return deps.service().readItem(id, ref)
  })
  deps.register('conversation:preview', (_event, id: unknown, request: unknown) => {
    if (typeof id !== 'string' || !id.trim() || !request || typeof request !== 'object') throw new Error('统一对话预览请求无效')
    return deps.service().preview(id, request)
  })
  deps.register('conversation:commands', async (_event, id: unknown, request: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error(taskSubmissionCopy.invalid)
    const target = request === undefined ? undefined : parseConversationTarget(request)
    await deps.getStartupManagedRecovery()
    const conversation = await deps.store().read(id)
    if (!conversation) throw new Error(taskSubmissionCopy.conversationMissing)
    if (conversation.deletion) throw new Error(taskSubmissionCopy.conversationDeleting)
    const cwd = await deps.resolveKnownProjectDirectoryAsync(conversation.cwd)
    return deps.listDesktopTaskCommands({ id: conversation.id, cwd }, target)
  })
  deps.register('conversation:submit', async (_event, input: unknown) => {
    const request = parseDesktopConversationSubmission(input)
    await deps.getStartupManagedRecovery()
    const conversation = await deps.store().read(request.conversationId)
    if (!conversation) throw new Error(taskSubmissionCopy.conversationMissing)
    if (conversation.deletion) throw new Error(taskSubmissionCopy.conversationDeleting)
    const cwd = await deps.resolveKnownProjectDirectoryAsync(conversation.cwd)
    return deps.submitDesktopConversation({ ...conversation, cwd }, request)
  })
  deps.register('conversation:send', (_event, request: unknown) => {
    if (!request || typeof request !== 'object') throw new Error('统一对话发送请求无效')
    return deps.submitDesktopTask(request)
  })

  return { prepareConversationDeletion }
}
