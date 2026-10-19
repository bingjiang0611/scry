import { createHash, randomUUID } from 'node:crypto'
import type { LoadedSessionTurn } from './session-history'
import { historicalInputBytes, historicalInputPrefix } from './providers/historical-input'
import { createConversationHistoryReader, type HistoryReaderConnection } from './conversation-history-reader'
import { providerAttachmentPrompt, type PreparedAttachment } from './attachment-store'
import type { ProviderHistoricalContext, ProviderInputReceipt } from './providers/types'
import type {
  ConversationArchiveRef,
  ConversationBinding,
  Conversation,
  ConversationContinuation,
  ConversationDelivery,
  ConversationItemRef,
  ConversationTarget
} from '../shared/conversation'
import { conversationItemKey, planConversationContinuation } from '../shared/conversation'
import type {
  ConversationMetadataChange,
  ConversationForkRequest,
  ConversationPage,
  ConversationPreview,
  ConversationSendRequest,
  ConversationSummary,
  ConversationTargetRequest
} from '../shared/conversation-api'
import { boundedControlValue, isAgentPermissionMode, isCommandId, normalizeAgentAttachments, type AgentStartRequest } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import { ConversationStore, assertConversationItems } from './conversation-store'
import { handoffBudget } from './conversation-handoff-budget'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const targetFields = ['providerId', 'agentProfileId', 'model', 'effort', 'permissionMode']

function requestObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new Error('统一对话请求格式或字段不受支持；仅支持普通文本和主进程派生的历史引用')
  }
  return value as Record<string, unknown>
}

function optionalControl(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const control = boundedControlValue(value)
  if (!control) throw new Error('统一对话模型或 effort 参数无效')
  return control
}

function parseTarget(value: Record<string, unknown>): ConversationTargetRequest {
  if (value.providerId !== 'claude' && value.providerId !== 'codex' && value.providerId !== 'pi') throw new Error('统一对话 Provider 不受支持')
  if (value.providerId === 'pi') {
    if (typeof value.agentProfileId !== 'string' || !/^pi:[a-f0-9]{16}$/.test(value.agentProfileId)) {
      throw new Error('统一对话 Pi 必须选择已登记的 Agent Profile')
    }
  } else if (value.agentProfileId !== undefined) throw new Error('统一对话仅支持 Pi 命名 Profile；Claude/Codex 仅支持默认配置')
  if (value.permissionMode !== undefined && !isAgentPermissionMode(value.permissionMode)) throw new Error('统一对话权限模式无效')
  let model: ConversationTargetRequest['model']
  if (value.model !== undefined) {
    const candidate = requestObject(value.model, ['id', 'providerId'])
    const id = optionalControl(candidate.id)
    if (!id) throw new Error('统一对话模型 ID 无效')
    model = { id, ...(candidate.providerId !== undefined ? { providerId: optionalControl(candidate.providerId) } : {}) }
  }
  return {
    providerId: value.providerId,
    ...(typeof value.agentProfileId === 'string' ? { agentProfileId: value.agentProfileId } : {}),
    model, effort: optionalControl(value.effort), permissionMode: value.permissionMode
  }
}

export function parseConversationTarget(input: unknown): ConversationTargetRequest {
  return parseTarget(requestObject(input, targetFields))
}

function parseSend(input: unknown): ConversationSendRequest {
  const value = requestObject(input, [...targetFields, 'conversationId', 'expectedRevision', 'expectedContinuationKey', 'commandId', 'prompt', 'attachments', 'selectedItems', 'confirmFresh'])
  const target = parseTarget(value)
  if (typeof value.conversationId !== 'string' || !value.conversationId ||
    !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 ||
    typeof value.expectedContinuationKey !== 'string' || !value.expectedContinuationKey ||
    typeof value.commandId !== 'string' || !isCommandId(value.commandId) ||
    typeof value.prompt !== 'string' || typeof value.confirmFresh !== 'boolean') throw new Error('统一对话发送参数无效')
  if (value.attachments !== undefined && !Array.isArray(value.attachments)) throw new Error('对话附件格式无效')
  const attachments = normalizeAgentAttachments(value.attachments).map(({ path: _path, ...attachment }) => attachment)
  if (Array.isArray(value.attachments) && attachments.length !== value.attachments.length) throw new Error('对话附件无效，输入未投递')
  assertConversationItems(value.selectedItems)
  const selectedItems = value.selectedItems.map((item) => {
    requestObject(item, ['runId', 'itemId', 'contentHash'])
    return { runId: item.runId, itemId: item.itemId, contentHash: item.contentHash }
  })
  return { ...target, conversationId: value.conversationId, expectedRevision: Number(value.expectedRevision),
    expectedContinuationKey: value.expectedContinuationKey, commandId: value.commandId,
    prompt: value.prompt, attachments, selectedItems, confirmFresh: value.confirmFresh }
}

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
    revision: conversation.revision,
    turnCount: conversation.turns.length,
    ...(lastRunOutcome ? { lastRunOutcome } : {}),
    ...(activeRunIds.has(pending?.runId ?? '') ? { activeRunId: pending?.runId } : {}),
    ...(pending ? { blockedReason: pending.delivery.status === 'unknown' ? pending.delivery.reason : activeRunIds.has(pending.runId) ? '当前轮仍在投递' : '投递结果尚未确认，且没有可关联的运行；请重启核查' } : {})
  }
}

function targetRequest(request: ConversationTargetRequest, continuationKey: string): ConversationTarget {
  return {
    providerId: request.providerId,
    ...(request.agentProfileId ? { agentProfileId: request.agentProfileId } : {}),
    continuationKey
  }
}

function payloadHash(input: {
  prompt: string
  attachments?: ConversationSendRequest['attachments']
  target: ConversationTarget
  cwd: string
  resumeSessionId: string | null
  model: ConversationSendRequest['model']
  effort: ConversationSendRequest['effort']
  permissionMode: ConversationSendRequest['permissionMode']
  selectedItems: ConversationItemRef[]
}): string {
  return hash(JSON.stringify({
    scope: 'plain-text-local-managed-v1',
    prompt: input.prompt,
    ...(input.attachments?.length ? { attachments: input.attachments.map(attachment => ({ ...attachment, dataBase64: hash(attachment.dataBase64) })) } : {}),
    target: input.target,
    cwd: input.cwd,
    resumeSessionId: input.resumeSessionId,
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissionMode,
    selectedItems: input.selectedItems
  }))
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
    return targetRequest(request, continuationKey)
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
    const value = requestObject(input, ['kind', 'title', 'pinned', 'archived'])
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
    const request = parseTarget(requestObject(input, targetFields))
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
      const duplicatePayloadHash = payloadHash({
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
        selectedItems: existing.importedItems
      })
      if (duplicate.disposition === 'duplicate') return { runId: duplicate.turn.runId, disposition: 'duplicate' }
      throw new Error('重复命令状态发生变化，请重新预览')
    }
    if (conversation.archivedAt) throw new Error('对话已存档，请先恢复')
    if (conversation.revision !== request.expectedRevision) throw new Error('对话已变化，请重新预览')
    if (!this.deps.supportsHistoricalInput(request.providerId)) throw new Error(`${request.providerId} 尚未提供可验证的历史输入交接`)
    const target = await this.target(conversation.cwd, request)
    if (target.continuationKey !== request.expectedContinuationKey) throw new Error('Provider 接续身份已变化，请重新预览')
    const continuation = planConversationContinuation(conversation, target)
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
    const payload = payloadHash({
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
    let reader: Awaited<ReturnType<typeof createConversationHistoryReader>> | undefined
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
      if (prepared.readerItems.length) reader = await createConversationHistoryReader(prepared.readerItems)
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
