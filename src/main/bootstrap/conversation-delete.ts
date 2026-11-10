import type { Conversation, ConversationDeletionResult, SideChatSource } from '../../shared/conversation'
import type { ConversationDeletionPreview, SideChatDeletionPreview } from '../../shared/conversation-api'
import type { ProviderId } from '../../shared/provider'
import type { AppSession } from '../app-store'
import { liveConversationDeletionCatalog, planConversationDeletion, resolveConversationDeletionRuns } from '../conversation-deletion'
import { sideChatsOf, sideChatTitle, withSideChats } from '../conversation-deletion-cascade'
import type { ConversationBootstrapDependencies } from './conversation'

type DeletionDependencies = Pick<ConversationBootstrapDependencies, 'handleTrusted' | 'providerContextKey' | 'contextAdmission' |
  'getStartupManagedRecovery' | 'appSessionStore' | 'conversationStore' | 'getRuns' | 'invalidateSessionHistoryLoad' | 'getWindow' |
  'deleteOneSession' | 'resolveSessionRunIds' | 'deleteConversationHistory' | 'appUserDataDir'>

/** One workspace read shared by every plan of one deletion, so N side chats do not list N times. */
interface WorkspaceEvidence { others: Conversation[]; sessions: AppSession[] }

/** A Provider session whose side chats are deleted with it; aliases name the same session. */
export interface NativeSideChatScope {
  providerId: ProviderId
  agentProfileId?: string
  cwd: string
  nativeSessionIds: readonly string[]
}

export interface SideChatCascade {
  /** Read-only: how many side chats a deletion of this session takes along. Throws when one cannot be deleted. */
  count(scope: NativeSideChatScope): Promise<number>
  /** Deletes them; an empty `failed` means none is left behind. */
  run(scope: NativeSideChatScope): Promise<Pick<ConversationDeletionResult, 'deleted' | 'retained' | 'failed'>>
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function registerConversationDeletionHandlers(deps: DeletionDependencies) {
  const { handleTrusted, providerContextKey, contextAdmission, getStartupManagedRecovery, appSessionStore, conversationStore,
    getRuns, invalidateSessionHistoryLoad, getWindow, deleteOneSession, resolveSessionRunIds, deleteConversationHistory,
    appUserDataDir } = deps

  function assertConversationDeletionIdle(conversation: Conversation): void {
    const runIds = new Set(conversation.turns.map(turn => turn.runId))
    if (getRuns().unsettledStates().some(run => runIds.has(run.runId))) throw new Error('对话仍有运行或证据保存未收敛，不能删除')
  }

  async function workspaceEvidence(cwd: string): Promise<WorkspaceEvidence> {
    return { others: await conversationStore().list(cwd), sessions: appSessionStore().load().filter(session => session.cwd === cwd) }
  }

  async function prepareConversationDeletion(conversation: Conversation, options: { cascade?: boolean; evidence?: WorkspaceEvidence } = {}) {
    const { others, sessions } = options.evidence ?? await workspaceEvidence(conversation.cwd)
    const catalog = liveConversationDeletionCatalog(others, sessions)
    return resolveConversationDeletionRuns(planConversationDeletion(conversation, others, catalog, { cascade: options.cascade === true }), target =>
      resolveSessionRunIds({ providerId: target.providerId, cwd: conversation.cwd, externalSessionId: target.externalSessionId, runIds: new Set() }), others, catalog)
  }

  /**
   * Plans every side chat a deletion takes along, or refuses the whole deletion.
   *
   * A child that is running or whose delivery is unresolved cannot be deleted, and deleting
   * the parent around it would strand it with no entry. The parent's panel is the only place
   * to resolve it, so the refusal names the child and nothing is deleted.
   */
  async function planSideChats(children: readonly Conversation[], evidence: WorkspaceEvidence): Promise<SideChatDeletionPreview[]> {
    const plans: SideChatDeletionPreview[] = []
    for (const child of children) {
      try {
        assertConversationDeletionIdle(child)
        const plan = await prepareConversationDeletion(child, { cascade: true, evidence })
        plans.push({ conversationId: child.id, title: sideChatTitle(child), revision: plan.revision,
          fingerprint: plan.fingerprint, targets: plan.targets })
      } catch (error) {
        throw new Error(`侧边会话「${sideChatTitle(child)}」不能随主会话删除：${message(error)}。请先在主会话的右侧面板处理它`)
      }
    }
    return plans
  }

  /** The plan a user confirms for one conversation: its own scope plus its side chats. */
  async function previewWithSideChats(conversation: Conversation): Promise<ConversationDeletionPreview> {
    const evidence = await workspaceEvidence(conversation.cwd)
    const plan = await prepareConversationDeletion(conversation, { evidence })
    // A side chat is never a parent, and nesting is refused at creation.
    if (conversation.sideChat) return plan
    const children = sideChatsOf([{ kind: 'conversation', conversationId: conversation.id }], evidence.others)
    return withSideChats(plan, await planSideChats(children, evidence))
  }

  /** Runs one deletion whose authorization is already persisted, down to its receipt. */
  async function executeDeletion(conversation: Conversation, plan: Pick<ConversationDeletionPreview, 'targets'>,
    fingerprint: string, result: ConversationDeletionResult): Promise<ConversationDeletionResult> {
    for (const target of plan.targets) {
      const scope = `${target.providerId}/${target.agentProfileId ?? 'default'}/${target.externalSessionId}`
      if (target.sharedWith.length) {
        result.retained.push(`shared Scry copies: ${scope} (${target.sharedWith.join(', ')})`)
        continue
      }
      try {
        const receipt = await deleteOneSession({ ...target, cwd: conversation.cwd }, {
          confirm: false, notifyFailure: false, conversationId: conversation.id, runIds: target.runIds
        })
        result.deleted.push(...receipt.deleted.map(store => `${scope}: ${store}`))
        result.retained.push(...receipt.retained)
        result.failed.push(...receipt.failed.map(failure => ({ ...failure, store: `${scope}: ${failure.store}` })))
        if (!receipt.ok && !receipt.failed.length) result.failed.push({ store: scope, error: receipt.reason ?? '删除结果未确认' })
      } catch (error) { result.failed.push({ store: scope, error: message(error) }) }
    }
    try {
      await deleteConversationHistory(appUserDataDir, conversation)
      result.deleted.push('frozen handoff bodies')
    } catch (error) { result.failed.push({ store: 'frozen handoff bodies', error: message(error) }) }
    result.retained = [...new Set(result.retained)]
    result.ok = result.failed.length === 0
    if (!result.ok) result.reason = 'partial_failure'
    await conversationStore().finishDeletion(conversation.id, fingerprint, result, plan.targets.some(target => target.sharedWith.length > 0))
    getWindow()?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: conversation.id })
    return result
  }

  const emptyResult = (): ConversationDeletionResult => ({ ok: false, deleted: [], retained: [], failed: [] })
  const bindingKeys = (conversation: Conversation): string[] =>
    conversation.bindings.map(binding => providerContextKey(binding.providerId, conversation.cwd, binding.agentProfileId))

  /**
   * Deletes the planned side chats, each by its own persisted authorization.
   *
   * Children go before their parent: if one fails, the parent keeps its entry and the user
   * can run the same deletion again, which plans the children that are left. A child that
   * changed since it was planned is refused instead of being deleted under a stale plan.
   */
  async function deleteSideChats(planned: readonly SideChatDeletionPreview[], into: ConversationDeletionResult): Promise<void> {
    for (const expected of planned) {
      const label = `side chat ${expected.conversationId.slice(0, 8)}`
      try {
        const child = await conversationStore().read(expected.conversationId)
        if (!child?.sideChat) throw new Error('侧边会话记录已不存在')
        // Its own delete key keeps the admission non-empty for a child that never sent, and
        // serializes this with a direct delete of the same child.
        const plan = await contextAdmission.runMany([`conversation-delete:${child.id}`, ...bindingKeys(child)], async () => {
          const current = (await conversationStore().read(child.id))!
          assertConversationDeletionIdle(current)
          const plan = await prepareConversationDeletion(current, { cascade: true })
          if (plan.fingerprint !== expected.fingerprint) throw new Error('侧边会话已变化，请重新预览删除')
          await conversationStore().beginDeletion(child.id, plan.revision, plan.fingerprint, false, true)
          return plan
        })
        const result = await executeDeletion(child, plan, plan.fingerprint, emptyResult())
        into.deleted.push(...result.deleted.map(store => `${label}: ${store}`))
        into.retained.push(...result.retained)
        into.failed.push(...result.failed.map(failure => ({ ...failure, store: `${label}: ${failure.store}` })))
      } catch (error) { into.failed.push({ store: label, error: message(error) }) }
    }
  }

  const nativeSources = (scope: NativeSideChatScope): SideChatSource[] => [...new Set(scope.nativeSessionIds)].map(nativeSessionId => ({
    kind: 'native-session' as const, providerId: scope.providerId, cwd: scope.cwd, nativeSessionId,
    ...(scope.agentProfileId ? { agentProfileId: scope.agentProfileId } : {})
  }))
  async function planNativeSideChats(scope: NativeSideChatScope): Promise<SideChatDeletionPreview[]> {
    const evidence = await workspaceEvidence(scope.cwd)
    return planSideChats(sideChatsOf(nativeSources(scope), evidence.others), evidence)
  }
  const sideChatCascade: SideChatCascade = {
    count: async scope => (await planNativeSideChats(scope)).length,
    run: async (scope) => {
      const result = emptyResult()
      const planned = await planNativeSideChats(scope)
      await deleteSideChats(planned, result)
      if (planned.length > 0) invalidateSessionHistoryLoad('side chats deleted with their source session')
      return { deleted: result.deleted, retained: [...new Set(result.retained)], failed: result.failed }
    }
  }

  handleTrusted('conversation:previewDeletion', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('对话删除请求无效')
    await getStartupManagedRecovery()
    const conversation = await conversationStore().read(id)
    if (!conversation || (conversation.deletion?.status === 'complete' && !conversation.deletion.retainedCopies)) throw new Error('对话不存在或没有待核对的保留副本')
    assertConversationDeletionIdle(conversation)
    return previewWithSideChats(conversation)
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
      const begin = async () => {
        const conversation = (await conversationStore().read(id))!
        assertConversationDeletionIdle(conversation)
        const plan = await previewWithSideChats(conversation)
        if (plan.fingerprint !== fingerprint) throw new Error('删除范围已变化，请重新预览；本次请求未执行清理')
        await conversationStore().beginDeletion(id, plan.revision, fingerprint, plan.reclaim === true)
        return { conversation, plan }
      }
      // A conversation that never sent has no Provider context to fence; the admission
      // refuses an empty key set, and this delete already holds the conversation's own key.
      const keys = bindingKeys(original)
      const { conversation, plan } = keys.length > 0 ? await contextAdmission.runMany(keys, begin) : await begin()
      const result: ConversationDeletionResult = {
        ok: false, deleted: [], retained: [
          'workspace .scry/ canonical turn evidence', 'Provider-native session transcript/history',
          'unattributed provider billing aggregates', 'unsent renderer composer drafts',
          'logical ownership tombstone (IDs, hashes and deletion receipt)'
        ], failed: []
      }
      await deleteSideChats(plan.sideChats ?? [], result)
      await executeDeletion(conversation, plan, fingerprint, result)
      invalidateSessionHistoryLoad('logical conversation deletion')
      return result
    })
  })
  return { prepareConversationDeletion: (conversation: Conversation) => prepareConversationDeletion(conversation), sideChatCascade }
}
