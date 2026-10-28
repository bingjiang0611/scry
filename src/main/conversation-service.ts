import { createHash } from 'node:crypto'
import type { LoadedSessionTurn } from './session-history'
import type { HistoryReaderConnection } from './conversation-history-reader'
import type { PreparedAttachment } from './attachment-store'
import type { ProviderHistoricalContext, ProviderInputReceipt } from './providers/types'
import type {
  ConversationArchiveRef,
  ConversationBinding,
  Conversation,
  ConversationContinuation,
  ConversationItemRef,
  ConversationTarget
} from '../shared/conversation'
import { conversationItemKey, planConversationContinuation } from '../shared/conversation'
import type {
  ConversationMetadataChange,
  ConversationForkRequest,
  ConversationPage,
  ConversationPreview,
  ConversationSummary,
  ConversationSendRequest,
  ConversationTargetRequest
} from '../shared/conversation-api'
import { isWorkflowConversationMode } from '../shared/workflow-mode'
import { WORKFLOW_MODE_COPY } from '../shared/constants/workflow-mode-copy'
import { isAgentPermissionMode, isCommandId, type AgentStartRequest } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import { ConversationStore, assertConversationItems } from './conversation-store'
import { parseConversationTarget, requestObject } from './conversation-request'
import { assertConversationForSend, assertConversationSendRevision, confirmedConversationContinuation, sendConversation } from './conversation-send'

export { parseConversationSend, parseConversationTarget } from './conversation-request'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

export interface ConversationTerminal {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  receipt?: ProviderInputReceipt
  finalItems: ConversationItemRef[]
  archive?: ConversationArchiveRef
}

export interface ManagedConversationStart {
  conversationId: string
  runId: string
  target: ConversationTarget
  resumeSessionId: string | null
  historicalContext?: ProviderHistoricalContext
  historyReader?: HistoryReaderConnection
  historyBudget?: import('./providers/types').ProviderRunRequest['historyBudget']
  /** Main calls this after materializing native attachments, before dispatch. */
  prepareInput: (attachments: PreparedAttachment[]) => { prompt: string; inputTextHash: string }
  /** Hash of the supported text/image/native settings scope frozen before launch. */
  requestHash: string
  inputTextHash: string
  /** Exact request fingerprint persisted in the durable command intent. */
  payloadHash: string
  onProviderDispatchAttempt?: () => void
  /** Main-owned task snapshot revalidation; runs before the dispatch marker. */
  beforeProviderDispatch?: (runId: string) => Promise<void>
  onTerminal: (terminal: ConversationTerminal) => Promise<void>
}

export interface ConversationServiceDeps {
  store: ConversationStore
  resolveContinuationKey: (context: { providerId: ProviderId; cwd: string; agentProfileId?: string }) => Promise<string>
  supportsHistoricalInput: (providerId: ProviderId) => boolean
  supportsHistoryReader?: (providerId: ProviderId) => boolean
  startAppRun: (request: AgentStartRequest, options: { managedConversation: ManagedConversationStart }) => Promise<{ runId: string }>
  forkNative?: (request: { source: Conversation; binding: ConversationBinding; turn: Conversation['turns'][number]; permissionMode: AgentStartRequest['permissionMode']; beforeFork: () => Promise<void> }) => Promise<string>
  loadItemText?: (conversation: Conversation, ref: ConversationItemRef) => Promise<string>
  loadTurn?: (conversation: Conversation, turn: Conversation['turns'][number]) => Promise<LoadedSessionTurn | undefined>
}

function summary(conversation: Conversation, activeRunIds: ReadonlySet<string>): ConversationSummary {
  const latest = conversation.turns.at(-1)
  const lastRunOutcome = latest?.origin === 'dispatch' && latest.delivery.status === 'accepted' ? latest.delivery.outcome : undefined
  const pending = conversation.turns.find((turn) => turn.origin === 'dispatch' &&
    (turn.delivery.status === 'pending' || turn.delivery.status === 'unknown')) as Extract<Conversation['turns'][number], { origin: 'dispatch' }> | undefined
  return {
    id: conversation.id,
    cwd: conversation.cwd,
    ...(conversation.deletion ? { deletion: structuredClone(conversation.deletion), blockedReason: '统一对话正在删除或已删除，不能执行' } : {}),
    ...(conversation.fork ? { fork: { sourceConversationId: conversation.fork.sourceConversationId, sourceRunId: conversation.fork.sourceRunId,
      bindingId: conversation.fork.bindingId, status: conversation.fork.status, reason: conversation.fork.reason },
      ...(conversation.fork.status !== 'accepted' && !conversation.deletion ? { blockedReason: conversation.fork.status === 'not_sent' ? `原生分支未创建：${conversation.fork.reason}` : `原生分支结果尚未确认：${conversation.fork.reason ?? '等待宿主回执'}；不会自动重建` } : {}) } : {}),
    title: conversation.title ?? `对话 ${conversation.id.slice(0, 8)}`,
    ...(conversation.pinnedAt ? { pinnedAt: conversation.pinnedAt } : {}),
    ...(conversation.archivedAt ? { archivedAt: conversation.archivedAt } : {}),
    ...(conversation.workflowMode ? { workflowMode: conversation.workflowMode } : {}),
    ...(conversation.workflowRoutingConsent ? { workflowRoutingConsent: structuredClone(conversation.workflowRoutingConsent) } : {}),
    revision: conversation.revision,
    turnCount: conversation.turns.length,
    ...(lastRunOutcome ? { lastRunOutcome } : {}),
    ...(activeRunIds.has(pending?.runId ?? '') ? { activeRunId: pending?.runId } : {}),
    ...(pending ? { blockedReason: pending.delivery.status === 'unknown' ? pending.delivery.reason : activeRunIds.has(pending.runId) ? '当前轮仍在投递' : '投递结果尚未确认，且没有可关联的运行；请重启核查' } : {})
  }
}

function missingDetails(conversation: Conversation, continuation: ConversationContinuation): ConversationPreview['missingItems'] {
  if (continuation.kind === 'blocked') return []
  const missing = new Set(continuation.missingItems.map(conversationItemKey))
  return conversation.turns.flatMap((turn) => {
    const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)
    return turn.items.filter((item) => missing.has(conversationItemKey(item))).map((item) => ({
      ref: item,
      ordinal: turn.ordinal,
      providerId: binding?.providerId ?? 'claude',
      role: item.itemId === 'assistant' ? 'assistant' as const : 'user' as const
    }))
  })
}

export class ConversationService {
  private readonly active = new Set<string>()

  constructor(private readonly deps: ConversationServiceDeps) {}

  private async target(cwd: string, request: ConversationTargetRequest): Promise<ConversationTarget> {
    const continuationKey = await this.deps.resolveContinuationKey({
      providerId: request.providerId,
      cwd,
      ...(request.agentProfileId ? { agentProfileId: request.agentProfileId } : {})
    })
    return {
      providerId: request.providerId,
      ...(request.agentProfileId ? { agentProfileId: request.agentProfileId } : {}),
      continuationKey
    }
  }

  async create(cwd: string): Promise<ConversationSummary> {
    return summary(await this.deps.store.create(cwd), this.active)
  }

  async fork(input: unknown): Promise<ConversationSummary> {
    const value = requestObject(input, ['conversationId', 'sourceRunId', 'expectedRevision', 'commandId', 'permissionMode'])
    if (typeof value.conversationId !== 'string' || typeof value.sourceRunId !== 'string' || !value.sourceRunId ||
      !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 || typeof value.commandId !== 'string' || !isCommandId(value.commandId) ||
      (value.permissionMode !== undefined && !isAgentPermissionMode(value.permissionMode))) throw new Error('分支请求无效')
    const request: ConversationForkRequest = { conversationId: value.conversationId, sourceRunId: value.sourceRunId,
      expectedRevision: Number(value.expectedRevision), commandId: value.commandId, permissionMode: value.permissionMode as AgentStartRequest['permissionMode'] ?? 'default' }
    const intentHash = hash(JSON.stringify(request))
    const existing = await this.deps.store.findFork(request.conversationId, request.commandId)
    if (existing) {
      if (existing.fork!.intentHash !== intentHash) throw new Error('同一分支命令不能替换内容')
      return summary(existing, this.active)
    }
    if (!this.deps.forkNative) throw new Error('原生分支不可用')
    const source = await this.deps.store.read(request.conversationId)
    const turn = source?.turns.find(item => item.runId === request.sourceRunId)
    const binding = source?.bindings.find(item => item.id === turn?.bindingId)
    if (!source || !turn || !binding?.nativeSessionId || binding.retiredReason) throw new Error('该轮缺少可验证的原生分支归属')
    const context = { providerId: binding.providerId, agentProfileId: binding.agentProfileId, cwd: source.cwd }
    const verifyIdentity = async (): Promise<void> => {
      if (await this.deps.resolveContinuationKey(context) !== binding.continuationKey) throw new Error('源 Agent 接续身份已变化，不能创建原生分支')
    }
    await verifyIdentity()
    const begun = await this.deps.store.beginFork(source.id, { ...request, intentHash })
    if (!begun.created) return summary(begun.conversation, this.active)
    let attempting = false
    try {
      const nativeSessionId = await this.deps.forkNative({ source, binding, turn, permissionMode: request.permissionMode, beforeFork: async () => {
        await verifyIdentity()
        await this.deps.store.assertManagedWriteAllowed({ conversationId: source.id, cwd: source.cwd, target: binding, nativeSessionId: binding.nativeSessionId })
        attempting = true
      } })
      if (!attempting) {
        attempting = true
        throw new Error('Provider 未遵守原生分支投递边界，结果未知')
      }
      if (!nativeSessionId || nativeSessionId === binding.nativeSessionId) throw new Error('Provider 未返回新的原生分支身份')
      await verifyIdentity()
      return summary(await this.deps.store.finishFork(begun.conversation.id, { status: 'accepted', nativeSessionId }), this.active)
    } catch (error) {
      // A successful atomic publish may lose its acknowledgement. Read, never replay the native fork.
      const persisted = await this.deps.store.read(begun.conversation.id)
      if (persisted?.fork?.status !== 'pending') {
        if (!persisted) throw error
        return summary(persisted, this.active)
      }
      return summary(await this.deps.store.finishFork(begun.conversation.id, {
        status: attempting ? 'unknown' : 'not_sent', reason: error instanceof Error ? error.message : String(error)
      }), this.active)
    }
  }

  async list(cwd: string): Promise<ConversationSummary[]> {
    const conversations = await this.deps.store.list(cwd)
    return conversations.filter(conversation => conversation.deletion?.status !== 'complete' || conversation.deletion.retainedCopies).map((conversation) => summary(conversation, this.active))
  }

  async nativeSessionAliases(cwd: string): Promise<Set<string>> {
    const conversations = await this.deps.store.list(cwd)
    return new Set(conversations.flatMap((conversation) => conversation.bindings.flatMap((binding) =>
      binding.nativeSessionId
        ? [`${binding.providerId}\0${binding.agentProfileId ?? ''}\0${conversation.cwd}\0${binding.nativeSessionId}`]
        : [])))
  }

  async read(id: string, beforeOrdinal?: number): Promise<ConversationPage> {
    const conversation = await this.deps.store.read(id)
    if (!conversation) throw new Error('找不到对话，不会自动创建空历史')
    if (conversation.deletion) return { summary: summary(conversation, this.active), bindings: structuredClone(conversation.bindings), turns: [] }
    const end = beforeOrdinal === undefined ? conversation.turns.length : Math.max(0, Math.min(beforeOrdinal, conversation.turns.length))
    const start = Math.max(0, end - 40)
    const turns = await Promise.all(conversation.turns.slice(start, end).map(async (turn) => {
      const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)!
      const history = this.deps.loadTurn ? await this.deps.loadTurn(conversation, turn) : undefined
      return {
        ordinal: turn.ordinal,
        runId: turn.runId,
        bindingId: turn.bindingId,
        providerId: binding.providerId,
        delivery: turn.origin === 'imported' ? { status: 'imported' as const } : turn.delivery,
        ...(history ? { history } : {}),
        ...(!history ? { unavailableReason: '历史正文需从其权威归档读取' } : {})
      }
    }))
    return {
      summary: summary(conversation, this.active),
      bindings: structuredClone(conversation.bindings),
      turns,
      ...(start > 0 ? { nextBeforeOrdinal: start } : {})
    }
  }

  async update(id: string, expectedRevision: number, input: unknown): Promise<ConversationSummary> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('对话 revision 无效')
    const value = requestObject(input, ['kind', 'title', 'pinned', 'archived', 'mode'])
    let change: ConversationMetadataChange
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
    } else if (value.kind === 'workflow_mode') {
      requestObject(value, ['kind', 'mode'])
      if (!isWorkflowConversationMode(value.mode)) throw new Error(WORKFLOW_MODE_COPY.invalid)
      change = { kind: 'workflow_mode', mode: value.mode }
    } else throw new Error('对话管理操作无效')
    return summary(await this.deps.store.updateMetadata(id, expectedRevision, change), this.active)
  }

  async readItem(id: string, input: unknown): Promise<string> {
    requestObject(input, ['runId', 'itemId', 'contentHash'])
    const refs = [input]
    assertConversationItems(refs)
    const ref = refs[0]
    const conversation = await this.deps.store.read(id)
    if (conversation?.deletion) throw new Error('统一对话正在删除或已删除，正文不可用')
    if (!conversation || !conversation.turns.some(turn => turn.items.some(item => conversationItemKey(item) === conversationItemKey(ref)))) {
      throw new Error('正文引用不属于当前对话')
    }
    if (!this.deps.loadItemText) throw new Error('完整正文读取不可用')
    return this.deps.loadItemText(conversation, ref)
  }

  async preview(id: string, input: unknown): Promise<ConversationPreview> {
    const request = parseConversationTarget(input)
    const conversation = await this.deps.store.read(id)
    if (!conversation) throw new Error('找不到对话，不会自动创建空历史')
    if (conversation.archivedAt) throw new Error('对话已存档，请先恢复')
    const target = await this.target(conversation.cwd, request)
    const continuation = planConversationContinuation(conversation, target)
    if (continuation.kind === 'blocked') throw new Error(continuation.reason)
    return {
      conversationId: id,
      revision: conversation.revision,
      target,
      continuation,
      missingItems: missingDetails(conversation, continuation)
    }
  }

  /** Read-only direct-entry preflight. Invalid fresh/history acknowledgements
   * must not publish a dispatch intent that would prevent explicit correction. */
  async prepareSubmission(request: ConversationSendRequest) {
    const conversation = await this.deps.store.read(request.conversationId)
    assertConversationForSend(conversation)
    assertConversationSendRevision(conversation, request, this.deps.supportsHistoricalInput)
    const target = await this.target(conversation.cwd, request)
    confirmedConversationContinuation(conversation, request, target)
    return { conversation, target }
  }

  async send(input: unknown, beforeProviderDispatch?: (runId: string) => Promise<void>): Promise<{ runId: string; disposition: 'created' | 'duplicate' }> {
    return sendConversation(input, {
      store: this.deps.store,
      supportsHistoricalInput: this.deps.supportsHistoricalInput,
      supportsHistoryReader: this.deps.supportsHistoryReader,
      startAppRun: this.deps.startAppRun,
      resolveTarget: (cwd, request) => this.target(cwd, request)
    }, this.active, beforeProviderDispatch)
  }
}
