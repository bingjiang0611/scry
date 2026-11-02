import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH } from '../shared/session-title'
import { conversationCoverage, planConversationContinuation, type Conversation, type ConversationArchiveRef,
  type ConversationBinding, type ConversationDeletionResult, type ConversationItemRef, type ConversationTarget,
  type ConversationTurn, type SideChatOrigin } from '../shared/conversation'
import { conversationIdPattern, nativeOwnerKey, requireValue, sideChatSource, text, type ConversationLedger } from './conversation-store'
import { sideChatPlanRefs } from './conversation-side-chat-snapshot'
import type { ConversationMetadataChange } from '../shared/conversation-api'

export interface ConversationSeed {
  target: ConversationTarget
  nativeSessionId: string
  retiredReason?: string
  adoptionFingerprint?: string
  title?: string
  pinnedAt?: number
  archivedAt?: number
  /** Authoritative existing turns only; this imports references, never clones trace/usage rows. */
  turns: Array<{ runId: string; items: ConversationItemRef[]; nativeItems: ConversationItemRef[]; archive?: ConversationArchiveRef }>
}

export interface SideChatConversationSeed {
  /** Allocated before sealing so the body lands under this child's own content root. */
  id: string
  cwd: string
  origin: SideChatOrigin
}

async function canonicalDirectory(cwd: string): Promise<string> {
  const canonical = await realpath(cwd)
  requireValue((await stat(canonical)).isDirectory(), '对话工作区不是目录')
  return canonical
}

/** Adoption path: a seeded conversation keeps the retired native capture as read-only history. */
export async function createConversation(ledger: ConversationLedger, cwd: string, seed?: ConversationSeed): Promise<Conversation> {
  const initial = seed ? structuredClone(seed) : undefined
  const canonical = await canonicalDirectory(cwd)
  const bindings: ConversationBinding[] = initial
    ? [{ ...initial.target, id: randomUUID(), nativeSessionId: initial.nativeSessionId, ...(initial.retiredReason ? { retiredReason: initial.retiredReason } : {}) }]
    : []
  const turns: ConversationTurn[] = initial ? initial.turns.map((turn, index) => ({
    ...turn, ordinal: index + 1, bindingId: bindings[0].id, origin: 'imported'
  })) : []
  const conversation = ledger.checked({ version: 1, id: randomUUID(), cwd: canonical, revision: 0, bindings, turns,
    ...(initial?.title ? { title: normalizeSessionTitle(initial.title) } : {}),
    ...(initial?.pinnedAt ? { pinnedAt: initial.pinnedAt } : {}),
    ...(initial?.archivedAt ? { archivedAt: initial.archivedAt } : {}),
    ...(initial?.adoptionFingerprint ? { adoptionFingerprint: initial.adoptionFingerprint } : {}) })
  return ledger.admission.run('ownership', async () => {
    if (initial?.adoptionFingerprint) {
      for (const owner of (await ledger.loadOwnership()).values()) {
        if (owner.cwd !== canonical || !owner.bindings.some(binding => nativeOwnerKey(canonical, binding) === nativeOwnerKey(canonical, bindings[0]))) continue
        requireValue(!owner.deletion, '旧会话正在删除或已删除，不能重新迁入')
        requireValue(owner.adoptionFingerprint === initial.adoptionFingerprint, '旧会话已归属统一对话，不能替换迁移内容')
        return structuredClone(owner)
      }
    }
    await ledger.persist(conversation, true)
    return conversation
  })
}

/**
 * Publish one local-only child for a frozen snapshot. No Provider call, no source
 * mutation and no adoption happen here; the sealed body is already durable.
 */
export async function createSideChatConversation(
  ledger: ConversationLedger,
  seed: SideChatConversationSeed
): Promise<{ conversation: Conversation; created: boolean }> {
  const origin = structuredClone(seed.origin)
  sideChatSource(origin.source)
  return ledger.admission.run('ownership', async () => {
    const existing = await findSideChatCommand(ledger, origin.commandId)
    if (existing) {
      requireValue(existing.sideChat?.intentHash === origin.intentHash, '同一侧聊创建命令不能替换内容或来源')
      return { conversation: existing, created: false }
    }
    const canonical = await canonicalDirectory(seed.cwd)
    requireValue(conversationIdPattern.test(seed.id), '侧聊 ID 无效')
    requireValue(origin.source.kind !== 'native-session' || origin.source.cwd === canonical, '侧聊工作区与冻结来源不一致')
    const conversation = ledger.checked({
      version: 1, id: seed.id, cwd: canonical, revision: 0, bindings: [], turns: [], sideChat: origin
    })
    await ledger.persist(conversation, true)
    return { conversation: structuredClone(conversation), created: true }
  })
}

/** Creation receipt lookup: a lost IPC acknowledgement must find the same child. */
export async function findSideChatCommand(ledger: ConversationLedger, commandId: string): Promise<Conversation | undefined> {
  return structuredClone([...(await ledger.loadOwnership()).values()].find(item => item.sideChat?.commandId === commandId))
}

export async function findFork(ledger: ConversationLedger, sourceId: string, commandId: string): Promise<Conversation | undefined> {
  return structuredClone([...(await ledger.loadOwnership()).values()].find(item =>
    item.fork?.sourceConversationId === sourceId && item.fork.commandId === commandId))
}

/** Publish the only fork intent before any native effect; never clone usage or trace rows. */
export async function beginFork(
  ledger: ConversationLedger,
  sourceId: string,
  input: { commandId: string; intentHash: string; expectedRevision: number; sourceRunId: string }
): Promise<{ conversation: Conversation; created: boolean }> {
  const request = structuredClone(input)
  return ledger.admission.run('ownership', async () => {
    const existing = await findFork(ledger, sourceId, request.commandId)
    if (existing) {
      requireValue(existing.fork?.intentHash === request.intentHash, '同一分支命令不能替换内容')
      return { conversation: existing, created: false }
    }
    const source = await ledger.required(sourceId)
    requireValue(source.revision === request.expectedRevision && !source.deletion && !source.archivedAt, '源对话已变化或不可执行，请重新读取')
    requireValue(!source.fork || source.fork.status === 'accepted', '源分支尚未确认')
    requireValue(!source.turns.some(turn => turn.origin === 'dispatch' && ['pending', 'unknown'].includes(turn.delivery.status)), '源对话投递尚未收敛')
    requireValue(![...(await ledger.loadOwnership()).values()].some(item => item.fork?.sourceConversationId === sourceId && ['pending', 'unknown'].includes(item.fork.status)), '此源对话已有未确认的原生分支，不能再次创建')
    const index = source.turns.findIndex(turn => turn.runId === request.sourceRunId)
    requireValue(index >= 0, '分支轮次不属于源对话')
    const selected = source.turns[index]
    const binding = source.bindings.find(item => item.id === selected.bindingId)!
    requireValue(binding.nativeSessionId && !binding.retiredReason && !binding.historyOnly && selected.origin === 'dispatch' && selected.delivery.status === 'accepted', '该轮没有可验证的原生分支归属')
    const prefix = source.turns.slice(0, index + 1)
    requireValue(prefix.every(turn => turn.archive), '分支历史缺少已提交归档')
    const bindingId = randomUUID()
    const referenced = new Set(prefix.map(turn => turn.bindingId))
    const titleSuffix = ' · 分支'
    const conversation: Conversation = {
      version: 1, id: randomUUID(), cwd: source.cwd, revision: 0,
      title: normalizeSessionTitle(`${(source.title ?? '对话').slice(0, SESSION_TITLE_MAX_LENGTH - titleSuffix.length)}${titleSuffix}`),
      bindings: [...source.bindings.filter(item => referenced.has(item.id)).map(item => ({
        id: item.id, providerId: item.providerId, agentProfileId: item.agentProfileId, continuationKey: item.continuationKey,
        historyOnly: true as const, retiredReason: '共享历史只读，不继承源原生会话的执行权'
      })), { id: bindingId, providerId: binding.providerId, agentProfileId: binding.agentProfileId, continuationKey: binding.continuationKey }],
      turns: prefix.map(turn => ({ origin: 'imported' as const, ordinal: turn.ordinal, runId: turn.runId,
        bindingId: turn.bindingId, items: turn.items, nativeItems: [], archive: turn.archive })),
      fork: { commandId: request.commandId, intentHash: request.intentHash, sourceConversationId: sourceId,
        sourceRevision: source.revision, sourceRunId: selected.runId, sourceBindingId: binding.id, bindingId,
        status: 'pending', inheritedItems: conversationCoverage({ ...source, turns: prefix }, binding.id) }
    }
    await ledger.persist(ledger.checked(conversation), true)
    return { conversation: structuredClone(conversation), created: true }
  })
}

export async function finishFork(
  ledger: ConversationLedger,
  id: string,
  result: { status: 'accepted'; nativeSessionId: string } | { status: 'not_sent' | 'unknown'; reason: string }
): Promise<Conversation> {
  const receipt = structuredClone(result)
  return ledger.admission.run('ownership', async () => {
    const conversation = await ledger.required(id)
    requireValue(conversation.fork?.status === 'pending' && !conversation.deletion, '分支意图已变化')
    const binding = conversation.bindings.find(item => item.id === conversation.fork!.bindingId)!
    if (receipt.status === 'accepted') binding.nativeSessionId = receipt.nativeSessionId
    conversation.fork.status = receipt.status
    if (receipt.status !== 'accepted') conversation.fork.reason = receipt.reason
    conversation.revision += 1
    await ledger.persist(ledger.checked(conversation))
    return structuredClone(conversation)
  })
}

export async function beginDeletion(
  ledger: ConversationLedger,
  id: string,
  revision: number,
  fingerprint: string,
  reclaim = false
): Promise<Conversation> {
  return ledger.admission.run('ownership', async () => {
    const conversation = await ledger.required(id)
    requireValue(conversation.revision === revision && (conversation.deletion?.status !== 'complete' || (reclaim && conversation.deletion.retainedCopies)), '对话已变化，请重新预览删除')
    requireValue(!conversation.fork || !['pending', 'unknown'].includes(conversation.fork.status), '原生分支尚未收敛，不能删除')
    requireValue(Boolean(conversation.archivedAt), '请先存档统一对话')
    requireValue(!conversation.turns.some(turn => turn.origin === 'dispatch' && ['pending', 'unknown'].includes(turn.delivery.status)), '投递未收敛，不能删除')
    conversation.deletion = { status: 'pending', fingerprint }
    conversation.revision++
    await ledger.persist(ledger.checked(conversation))
    return conversation
  })
}

export async function finishDeletion(
  ledger: ConversationLedger,
  id: string,
  fingerprint: string,
  result: ConversationDeletionResult,
  retainedCopies = false
): Promise<void> {
  const receipt = structuredClone(result)
  return ledger.admission.run('ownership', async () => {
    const conversation = await ledger.required(id)
    requireValue(conversation.deletion?.status === 'pending' && conversation.deletion.fingerprint === fingerprint, '删除操作已变化')
    conversation.deletion = { status: receipt.ok ? 'complete' : 'pending', fingerprint, result: receipt, ...(retainedCopies ? { retainedCopies: true } : {}) }
    if (receipt.ok) {
      delete conversation.title
      delete conversation.pinnedAt
      for (const binding of conversation.bindings) if (binding.nativeSessionId || binding.historyOnly) binding.retiredReason = '已删除的统一对话'
      for (const turn of conversation.turns) {
        if (turn.origin === 'dispatch' && turn.delivery.status === 'not_sent') turn.delivery.reason = '已删除的统一对话'
      }
    }
    conversation.revision++
    await ledger.persist(ledger.checked(conversation))
  })
}

export async function updateConversationMetadata(
  ledger: ConversationLedger,
  id: string,
  expectedRevision: number,
  change: ConversationMetadataChange
): Promise<Conversation> {
  const request = structuredClone(change)
  return ledger.admission.run('ownership', async () => {
    const conversation = await ledger.required(id)
    requireValue(!conversation.deletion, '统一对话正在删除或已删除，不能修改')
    requireValue(conversation.revision === expectedRevision, '对话已变化，请刷新后重试')
    if (request.kind === 'rename') conversation.title = normalizeSessionTitle(request.title)
    else if (request.kind === 'pin') {
      if (request.pinned) conversation.pinnedAt ??= Date.now()
      else delete conversation.pinnedAt
    } else {
      requireValue(!conversation.turns.some(turn => turn.origin === 'dispatch' && (turn.delivery.status === 'pending' || turn.delivery.status === 'unknown')), '投递未收敛，先停止或核查后再存档')
      if (request.archived) conversation.archivedAt ??= Date.now()
      else delete conversation.archivedAt
    }
    conversation.revision++
    const checked = ledger.checked(conversation)
    await ledger.persist(checked)
    return checked
  })
}

/** Main must first verify native ownership and obtain the user's explicit replacement choice. */
export async function retireConversationBinding(
  ledger: ConversationLedger,
  id: string,
  expectedRevision: number,
  bindingId: string,
  reason: string
): Promise<Conversation> {
  return ledger.admission.run('ownership', async () => {
    requireValue(text(reason), '弃用原生绑定必须说明原因')
    const conversation = await ledger.required(id)
    requireValue(conversation.revision === expectedRevision, '对话已变化，请重新预览')
    const binding = conversation.bindings.find((candidate) => candidate.id === bindingId)
    requireValue(binding?.nativeSessionId !== undefined, '找不到可弃用的原生绑定')
    const plan = planConversationContinuation(conversation, binding,
      conversation.sideChat ? await sideChatPlanRefs(ledger.userData, conversation) : undefined)
    if (plan.kind === 'blocked') throw new Error(plan.reason)
    requireValue(binding.retiredReason === undefined, '该原生绑定已经弃用')
    binding.retiredReason = reason
    conversation.revision++
    const checked = ledger.checked(conversation)
    await ledger.persist(checked)
    return checked
  })
}
