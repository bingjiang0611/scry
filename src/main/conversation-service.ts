import { createHash, randomUUID } from 'node:crypto'
import { historicalInputBytes, historicalInputPrefix } from './providers/historical-input'
import { openConversationHistoryReader } from './conversation-history-reader'
import { providerAttachmentPrompt } from './attachment-store'
import type {
  ConversationContinuation,
  ConversationDelivery,
  ConversationTarget
} from '../shared/conversation'
import { conversationItemKey, planConversationContinuation, sideChatSnapshotIndexOf } from '../shared/conversation'
import type {
  ConversationPage,
  ConversationPreview,
  ConversationSummary,
  ConversationTargetRequest,
  SideChatSnapshotBodyPage
} from '../shared/conversation-api'
import type { ConversationServiceDeps, ConversationTerminal } from './conversation-service-deps'
import { ConversationStore } from './conversation-store'
import { assertConversationItems } from './conversation-schema'
import { handoffBudget } from './conversation-handoff-budget'
import { conversationSummary, dispatchPayloadHash, missingDetails, targetRequest } from './conversation-summary'
import { parseConversationFork, parseConversationTarget, parseSend, requestObject, targetFields } from './conversation-request'
import { forkConversation } from './conversation-fork'
import { createSideChat, findSideChatCommand, listSideChats, previewSideChat } from './conversation-side-chat'
import { readConversationPage } from './conversation-read'
import {
  belongsToSideChatSnapshot, readSideChatSnapshotBodyPage, readSideChatSnapshotMessage, sideChatPlanRefs
} from './conversation-side-chat-snapshot'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

export type { ConversationServiceDeps, ConversationTerminal, ManagedConversationStart } from './conversation-service-deps'
export { parseConversationTarget }

export class ConversationService {
  private readonly active = new Set<string>()

  constructor(private readonly deps: ConversationServiceDeps) {}

  private async target(cwd: string, request: ConversationTargetRequest): Promise<ConversationTarget> {
    const continuationKey = await this.deps.resolveContinuationKey({
      providerId: request.providerId,
      cwd,
      ...(request.agentProfileId ? { agentProfileId: request.agentProfileId } : {})
    })
    return targetRequest(request, continuationKey)
  }

  async create(cwd: string): Promise<ConversationSummary> {
    return conversationSummary(await this.deps.store.create(cwd), this.active)
  }

  async fork(input: unknown): Promise<ConversationSummary> {
    return forkConversation(this.deps, this.active, parseConversationFork(input))
  }

  async list(cwd: string): Promise<ConversationSummary[]> {
    return (await this.listCatalog(cwd)).conversations
  }

  async nativeSessionAliases(cwd: string): Promise<Set<string>> {
    return (await this.listCatalog(cwd)).ownedNativeAliases
  }

  /**
   * The project catalog seam: one store read answers both what the sidebar shows and
   * which native sessions an owned conversation already represents.
   *
   * Sidebar rows and the alias filter must agree, so they are derived from the same list
   * instead of two independent reads of the same store file.
   */
  async listCatalog(cwd: string): Promise<{ conversations: ConversationSummary[]; ownedNativeAliases: Set<string> }> {
    const stored = await this.deps.store.list(cwd)
    const ownedNativeAliases = new Set(stored.flatMap((conversation) => conversation.bindings.flatMap((binding) =>
      binding.nativeSessionId
        ? [`${binding.providerId}\0${binding.agentProfileId ?? ''}\0${conversation.cwd}\0${binding.nativeSessionId}`]
        : [])))
    const conversations = stored
      .filter(conversation => conversation.deletion?.status !== 'complete' || conversation.deletion.retainedCopies)
      .map((conversation) => conversationSummary(conversation, this.active))
    return { conversations, ownedNativeAliases }
  }

  async read(id: string, beforeOrdinal?: number): Promise<ConversationPage> {
    return readConversationPage(this.deps, this.active, id, beforeOrdinal)
  }

  async update(id: string, expectedRevision: number, input: unknown): Promise<ConversationSummary> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('对话 revision 无效')
    const value = requestObject(input, ['kind', 'title', 'pinned', 'archived'])
    let change: Parameters<ConversationStore['updateMetadata']>[2]
    if (value.kind === 'rename') {
      requestObject(value, ['kind', 'title'])
      if (typeof value.title !== 'string') throw new Error('对话名称无效')
      change = { kind: 'rename', title: value.title }
    } else if (value.kind === 'pin' && typeof value.pinned === 'boolean') {
      requestObject(value, ['kind', 'pinned'])
      change = { kind: 'pin', pinned: value.pinned }
    } else if (value.kind === 'archive' && typeof value.archived === 'boolean') {
      requestObject(value, ['kind', 'archived'])
      change = { kind: 'archive', archived: value.archived }
    } else throw new Error('对话管理操作无效')
    return conversationSummary(await this.deps.store.updateMetadata(id, expectedRevision, change), this.active)
  }

  async readItem(id: string, input: unknown): Promise<string> {
    requestObject(input, ['runId', 'itemId', 'contentHash'])
    const refs = [input]
    assertConversationItems(refs)
    const ref = refs[0]
    const conversation = await this.deps.store.read(id)
    if (conversation?.deletion) throw new Error('统一对话正在删除或已删除，正文不可用')
    if (!conversation) throw new Error('正文引用不属于当前对话')
    const frozen = conversation.sideChat !== undefined &&
      sideChatSnapshotIndexOf(conversation.sideChat.snapshot, ref) >= 0
    if (!frozen && !conversation.turns.some(turn => turn.items.some(item => conversationItemKey(item) === conversationItemKey(ref)))) {
      throw new Error('正文引用不属于当前对话')
    }
    // A frozen ref resolves only inside this child's snapshot; a source ref never does.
    if (frozen || belongsToSideChatSnapshot(conversation, ref)) {
      return (await readSideChatSnapshotMessage(this.deps.store.userData, conversation, ref)).text
    }
    if (!this.deps.loadItemText) throw new Error('完整正文读取不可用')
    return this.deps.loadItemText(conversation, ref)
  }

  async preview(id: string, input: unknown): Promise<ConversationPreview> {
    const request = parseConversationTarget(requestObject(input, targetFields))
    const conversation = await this.deps.store.read(id)
    if (!conversation) throw new Error('找不到对话，不会自动创建空历史')
    if (conversation.archivedAt) throw new Error('对话已存档，请先恢复')
    const target = await this.target(conversation.cwd, request)
    const continuation: ConversationContinuation = planConversationContinuation(conversation, target,
      conversation.sideChat ? await sideChatPlanRefs(this.deps.store.userData, conversation) : undefined)
    if (continuation.kind === 'blocked') throw new Error(continuation.reason)
    return {
      conversationId: id,
      revision: conversation.revision,
      target,
      continuation,
      missingItems: await missingDetails(this.deps.store.userData, conversation, continuation)
    }
  }

  previewSideChat(input: unknown, options?: unknown) {
    return previewSideChat(this.deps, input, options)
  }

  createSideChat(input: unknown) {
    return createSideChat(this.deps, this.active, input)
  }

  listSideChats(input: unknown) {
    return listSideChats(this.deps, this.active, input)
  }

  /** Read-only receipt lookup; never creates, adopts or starts a Provider. */
  findSideChatCommand(source: unknown, commandId: unknown) {
    return findSideChatCommand(this.deps, this.active, source, commandId)
  }

  /** Bounded real bodies of this child's own frozen snapshot; a source is never read. */
  async readSideChatSnapshot(id: string, cursor?: unknown): Promise<SideChatSnapshotBodyPage> {
    if (typeof id !== 'string' || !id.trim()) throw new Error('统一对话 ID 无效')
    if (cursor !== undefined && typeof cursor !== 'string') throw new Error('侧聊正文游标无效')
    const conversation = await this.deps.store.read(id)
    if (conversation?.deletion) throw new Error('统一对话正在删除或已删除，正文不可用')
    if (!conversation?.sideChat) throw new Error('该对话没有冻结的侧聊快照')
    return readSideChatSnapshotBodyPage(this.deps.store.userData, conversation, cursor)
  }

  async send(input: unknown): Promise<{ runId: string; disposition: 'created' | 'duplicate' }> {
    const request = parseSend(input)
    const prompt = request.prompt
    if (!prompt.trim() && !request.attachments?.length) throw new Error('对话请求不能为空')
    if (/^\s*\//.test(prompt)) throw new Error('统一对话仅支持普通文本，不支持 slash 命令')
    const conversation = await this.deps.store.read(request.conversationId)
    if (!conversation) throw new Error('找不到对话，不会自动创建空历史')
    if (conversation.deletion) throw new Error('统一对话正在删除或已删除，不能发送')
    // Resolve an existing command from its immutable binding before checking
    // current continuation state. A pending/unknown retry must return its
    // original attempt, not be blocked by the current plan.
    const existing = await this.deps.store.findDispatch(request.conversationId, request.commandId)
    if (existing) {
      const binding = conversation.bindings.find((candidate) => candidate.id === existing.bindingId)
      if (!binding) throw new Error('重复命令引用了未知原生绑定')
      if (request.providerId !== binding.providerId || request.agentProfileId !== (binding.agentProfileId ?? undefined) ||
        request.expectedContinuationKey !== binding.continuationKey) {
        throw new Error('同一命令 ID 不能替换请求内容或目标')
      }
      const duplicateTarget: ConversationTarget = {
        providerId: binding.providerId,
        ...(binding.agentProfileId ? { agentProfileId: binding.agentProfileId } : {}),
        continuationKey: binding.continuationKey
      }
      const duplicatePayloadHash = dispatchPayloadHash({
        prompt, attachments: request.attachments, target: duplicateTarget, cwd: conversation.cwd,
        resumeSessionId: existing.resumeSessionId,
        model: request.model, effort: request.effort,
        permissionMode: request.permissionMode, selectedItems: existing.importedItems
      })
      const duplicateRunId = randomUUID()
      const duplicate = await this.deps.store.begin(request.conversationId, {
        expectedRevision: request.expectedRevision,
        commandId: request.commandId,
        runId: duplicateRunId,
        target: duplicateTarget,
        payloadHash: duplicatePayloadHash,
        items: [],
        // A retry reuses the exact immutable selection published by the first attempt.
        selectedItems: existing.importedItems,
        firstQuestion: prompt
      })
      if (duplicate.disposition === 'duplicate') return { runId: duplicate.turn.runId, disposition: 'duplicate' }
      throw new Error('重复命令状态发生变化，请重新预览')
    }
    if (conversation.archivedAt) throw new Error('对话已存档，请先恢复')
    if (conversation.revision !== request.expectedRevision) throw new Error('对话已变化，请重新预览')
    if (!this.deps.supportsHistoricalInput(request.providerId)) throw new Error(`${request.providerId} 尚未提供可验证的历史输入交接`)
    const target = await this.target(conversation.cwd, request)
    if (target.continuationKey !== request.expectedContinuationKey) throw new Error('Provider 接续身份已变化，请重新预览')
    const continuation = planConversationContinuation(conversation, target,
      conversation.sideChat ? await sideChatPlanRefs(this.deps.store.userData, conversation) : undefined)
    if (continuation.kind === 'blocked') throw new Error(continuation.reason)
    if (continuation.kind === 'fresh' && !request.confirmFresh) throw new Error('创建新的原生上下文需要明确确认')
    if (JSON.stringify(request.selectedItems.map(conversationItemKey)) !== JSON.stringify(continuation.missingItems.map(conversationItemKey))) {
      throw new Error('待交接历史与确认的预览不一致，请重新预览')
    }
    const prepared = await this.deps.store.prepareHandoff(conversation, continuation.missingItems,
      { userText: prompt, attachments: request.attachments ?? [] },
      this.deps.supportsHistoryReader?.(request.providerId) === true,
      continuation.kind === 'resume' ? { bindingId: continuation.bindingId, model: request.model } : undefined)
    const selectedItems = prepared.selectedItems
    const runId = randomUUID()
    const payload = dispatchPayloadHash({
      prompt, attachments: request.attachments, target, cwd: conversation.cwd,
      resumeSessionId: continuation.kind === 'resume' ? continuation.nativeSessionId : null,
      model: request.model, effort: request.effort,
      permissionMode: request.permissionMode, selectedItems
    })
    const begun = await this.deps.store.begin(request.conversationId, {
      expectedRevision: request.expectedRevision,
      commandId: request.commandId,
      runId,
      target,
      payloadHash: payload,
      items: [],
      selectedItems,
      firstQuestion: prompt,
      preparedHistory: prepared.history
    })
    if (begun.disposition === 'duplicate') return { runId: begun.turn.runId, disposition: 'duplicate' }
    const context = await this.deps.store.history(request.conversationId, runId)
    const requestHash = hash(JSON.stringify({
      scope: 'plain-text-local-managed-v1', payloadHash: payload,
      historyHash: context?.contentHash ?? null
    }))
    this.active.add(runId)
    let dispatched = false
    let inputTextHash = hash(context ? historicalInputPrefix(context) + prompt : prompt)
    let reader: Awaited<ReturnType<typeof openConversationHistoryReader>> | undefined
    let inputPrepared = false
    const settle = async (terminal: ConversationTerminal): Promise<void> => {
      if (terminal.receipt?.status === 'accepted' && terminal.archive) {
        if (terminal.receipt.contextHash !== (context?.contentHash ?? null)) throw new Error('Provider 回执的历史 hash 不匹配')
        if (terminal.receipt.textHash !== inputTextHash) throw new Error('Provider 回执的输入正文 hash 不匹配')
        if (begun.turn.resumeSessionId && terminal.receipt.nativeSessionId !== begun.turn.resumeSessionId) {
          throw new Error('Provider 回执的原生 session 与冻结目标不一致')
        }
        const delivery: ConversationDelivery = {
          status: 'accepted',
          nativeSessionId: terminal.receipt.nativeSessionId,
          outcome: terminal.status,
          nativeItems: terminal.finalItems
        }
        await this.deps.store.settle(request.conversationId, runId, delivery, terminal.finalItems, terminal.archive)
        return
      }
      const notSent = terminal.receipt?.status === 'not_sent' || (!terminal.receipt && !dispatched)
      const delivery: ConversationDelivery = notSent
        ? { status: 'not_sent', reason: terminal.receipt?.status === 'not_sent' ? terminal.receipt.reason : '在调用 Provider 前已停止，输入未投递' }
        : { status: 'unknown', reason: terminal.receipt?.status === 'unknown'
          ? terminal.receipt.reason
          : 'Provider 终态缺少可归属的接收回执或权威归档；不会自动重发' }
      await this.deps.store.settle(request.conversationId, runId, delivery, [], terminal.archive)
    }
    try {
      if (prepared.reader) reader = await openConversationHistoryReader(prepared.reader)
      const started = await this.deps.startAppRun({
        prompt,
        attachments: request.attachments,
        cwd: conversation.cwd,
        providerId: request.providerId,
        agentProfileId: request.agentProfileId,
        expectedExternalSessionId: begun.turn.resumeSessionId,
        model: request.model,
        effort: request.effort,
        permissionMode: request.permissionMode
      }, { managedConversation: {
        conversationId: request.conversationId,
        runId,
        target,
        resumeSessionId: begun.turn.resumeSessionId,
        ...(context ? { historicalContext: context } : {}),
        historyReader: reader?.connection,
        historyBudget: { contextUsage: prepared.budget.contextUsage, modelContextWindow: prepared.budget.modelContextWindow },
        prepareInput: attachments => {
          const preparedPrompt = providerAttachmentPrompt(request.providerId, prompt, attachments)
          if (context && historicalInputBytes(context.text) > handoffBudget({ ...prepared.budget, userText: preparedPrompt })) {
            throw new Error('最终输入（含附件提示与历史包装）超出交接预算，输入未投递')
          }
          inputTextHash = hash(context ? historicalInputPrefix(context) + preparedPrompt : preparedPrompt)
          inputPrepared = true
          return { prompt: preparedPrompt, inputTextHash }
        },
        requestHash,
        inputTextHash,
        payloadHash: payload,
        onProviderDispatchAttempt: () => {
          if (request.attachments?.length && !inputPrepared) throw new Error('当前附件尚未准备，输入未投递')
          dispatched = true
        },
        onTerminal: async (terminal) => {
          try {
            await settle(terminal)
          } catch (error) {
            // Receipt/archive mismatches are evidence gaps, not a reason to
            // leave the durable attempt pending or make it retryable.
            try {
              await this.deps.store.settle(request.conversationId, runId, {
                status: 'unknown', reason: `统一对话终态证据不完整：${String((error as Error).message ?? error)}`
              }, [], terminal.archive)
            } catch (settlementError) {
              console.error('[scry] failed to record unknown managed outcome:', settlementError)
            }
            throw error
          } finally { this.active.delete(runId); await reader?.close() }
        }
      }})
      if (started.runId !== runId) throw new Error('统一对话 runner 返回了不同的 runId')
      return { runId: started.runId, disposition: 'created' }
    } catch (error) {
      try {
        await settle({
          status: 'failed',
          finalItems: [],
          receipt: dispatched ? { contextHash: context?.contentHash ?? null, status: 'unknown', textHash: hash(prompt), reason: String((error as Error).message ?? error) } :
            { contextHash: context?.contentHash ?? null, status: 'not_sent', reason: String((error as Error).message ?? error) }
        })
      } finally {
        this.active.delete(runId)
        await reader?.close()
      }
      throw error
    }
  }
}
