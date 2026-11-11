import { adoptingConversationOf } from './conversation-side-chat'
import type { ConversationContinuation, ConversationTarget } from '../shared/conversation'
import { conversationItemKey, planConversationContinuation, sideChatSnapshotIndexOf } from '../shared/conversation'
import type {
  ConversationPage,
  ConversationPreview,
  ConversationSendResult,
  ConversationSummary,
  ConversationTargetRequest,
  SideChatSnapshotBodyPage
} from '../shared/conversation-api'
import type { ConversationServiceDeps } from './conversation-service-deps'
import { sendConversationMessage } from './conversation-send'
import { ConversationStore } from './conversation-store'
import { assertConversationItems } from './conversation-schema'
import { conversationSummary, missingDetails, targetRequest } from './conversation-summary'
import { parseConversationFork, parseConversationTarget, requestObject, targetFields } from './conversation-request'
import { forkConversation } from './conversation-fork'
import { createSideChat, findSideChatCommand, listSideChats, previewSideChat } from './conversation-side-chat'
import { readConversationPage } from './conversation-read'
import {
  belongsToSideChatSnapshot, readSideChatSnapshotBodyPage, readSideChatSnapshotMessage, sideChatPlanRefs
} from './conversation-side-chat-snapshot'

export type { ConversationServiceDeps, ConversationTerminal, ManagedConversationStart } from './conversation-service-deps'
export { parseConversationTarget }

export class ConversationService {
  private readonly active = new Set<string>()
  /** Side-chat create commands this host is executing right now. */
  private readonly creatingSideChats = new Set<string>()

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
  async listCatalog(cwd: string): Promise<{ conversations: ConversationSummary[]; ownedNativeAliases: Set<string>; ownedRunIds: Set<string> }> {
    const stored = await this.deps.store.list(cwd)
    const ownedNativeAliases = new Set(stored.flatMap((conversation) => conversation.bindings.flatMap((binding) =>
      binding.nativeSessionId
        ? [`${binding.providerId}\0${binding.agentProfileId ?? ''}\0${conversation.cwd}\0${binding.nativeSessionId}`]
        : [])))
    // A conversation's own run is catalogued under that run id before its binding learns
    // the native session id: a first turn that is still running, or one that never got a
    // receipt. Without this, a side chat's running turn showed up as a Provider row.
    const ownedRunIds = new Set(stored.flatMap((conversation) => conversation.turns.flatMap((turn) => {
      const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)
      return binding ? [`${binding.providerId}\0${conversation.cwd}\0${turn.runId}`] : []
    })))
    const conversations = stored
      .filter(conversation => conversation.deletion?.status !== 'complete' || conversation.deletion.retainedCopies)
      .map((conversation) => {
        const summary = conversationSummary(conversation, this.active)
        // A side chat of an adopted Provider session belongs to the adopting conversation's row.
        const adopted = summary.sideChat && adoptingConversationOf(summary.sideChat.source, stored)
        return adopted && summary.sideChat ? { ...summary, sideChat: { ...summary.sideChat, parentConversationId: adopted.id } } : summary
      })
    return { conversations, ownedNativeAliases, ownedRunIds }
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
    // The command id is tracked while it runs, so a read-back from a reloaded renderer can
    // tell "still creating" from "created nothing" instead of guessing.
    const commandId = typeof input === 'object' && input !== null && typeof (input as { commandId?: unknown }).commandId === 'string'
      ? (input as { commandId: string }).commandId : undefined
    if (commandId) this.creatingSideChats.add(commandId)
    return createSideChat(this.deps, this.active, input).finally(() => { if (commandId) this.creatingSideChats.delete(commandId) })
  }

  listSideChats(input: unknown) {
    return listSideChats(this.deps, this.active, input)
  }

  /** Read-only receipt lookup; never creates, adopts or starts a Provider. */
  findSideChatCommand(source: unknown, commandId: unknown) {
    return findSideChatCommand(this.deps, this.active, source, commandId, this.creatingSideChats)
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

  /** Typed answer of one send: accepted, host-proven not sent, or a thrown unknown. */
  async send(input: unknown): Promise<ConversationSendResult> {
    return sendConversationMessage({ deps: this.deps, active: this.active }, input)
  }
}
