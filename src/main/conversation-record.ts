import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { normalizeSessionTitle } from '../shared/session-title'
import { isWorkflowConversationMode } from '../shared/workflow-mode'
import { isCommandId } from '../shared/runtime'
import { isToolContentRef } from '../shared/tool-content'
import { MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES } from './conversation-history'
import { conversationItemKey } from '../shared/conversation'
import type {
  Conversation,
  ConversationArchiveRef,
  ConversationBinding,
  ConversationItemRef,
  ConversationTarget,
  ConversationTurn,
  DispatchedConversationTurn
} from '../shared/conversation'

export const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export const hashPattern = /^[a-f0-9]{64}$/
const providers = new Set(['claude', 'codex', 'qoder', 'opencode', 'pi'])
const outcomes = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
export const maxBytes = 16 * 1024 * 1024

export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
export function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), '对话记录必须是对象')
  return value as Record<string, unknown>
}
export function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
export function target(value: unknown): asserts value is ConversationTarget {
  const data = object(value)
  requireValue(typeof data.providerId === 'string' && providers.has(data.providerId), '对话 Provider 无效')
  requireValue(data.agentProfileId === undefined || text(data.agentProfileId), '对话 Profile 无效')
  requireValue(text(data.continuationKey), '缺少原生接续兼容身份')
}
export function items(value: unknown): asserts value is ConversationItemRef[] {
  requireValue(Array.isArray(value), '对话内容引用必须是数组')
  const keys = new Set<string>()
  for (const raw of value) {
    const item = object(raw)
    requireValue(text(item.runId) && text(item.itemId) && typeof item.contentHash === 'string' &&
      hashPattern.test(item.contentHash), '对话内容引用无效')
    const key = JSON.stringify([item.runId, item.itemId])
    requireValue(!keys.has(key), '对话内容引用重复')
    keys.add(key)
  }
}
export { items as assertConversationItems }

export function subset(selected: ConversationItemRef[], available: ConversationItemRef[]): boolean {
  const keys = new Set(available.map(conversationItemKey))
  return selected.every((item) => keys.has(conversationItemKey(item)))
}

/** Decode persisted state before using any identity or coverage. Corruption is not empty history. */
export function decodeConversation(value: unknown): Conversation {
  const data = object(value)
  requireValue(data.version === 1 && typeof data.id === 'string' && idPattern.test(data.id), '对话版本或 ID 无效')
  requireValue(typeof data.cwd === 'string' && isAbsolute(data.cwd), '对话工作区必须是绝对路径')
  requireValue(Number.isSafeInteger(data.revision) && Number(data.revision) >= 0, '对话 revision 无效')
  if (data.title !== undefined) requireValue(normalizeSessionTitle(data.title) === data.title, '对话名称无效')
  for (const field of ['pinnedAt', 'archivedAt']) requireValue(data[field] === undefined || (Number.isSafeInteger(data[field]) && Number(data[field]) > 0), '对话元数据时间无效')
  requireValue(data.adoptionFingerprint === undefined || (typeof data.adoptionFingerprint === 'string' && hashPattern.test(data.adoptionFingerprint)), '迁移指纹无效')
  requireValue(data.workflowMode === undefined || isWorkflowConversationMode(data.workflowMode), '对话工作流模式无效')
  if (data.workflowRoutingConsent !== undefined) {
    const consent = object(data.workflowRoutingConsent)
    requireValue(Number.isSafeInteger(consent.grantedAt) && Number(consent.grantedAt) > 0, '路由授权时间无效')
    requireValue(typeof consent.scope === 'string' && consent.scope.length > 0 && consent.scope.length <= 512, '路由授权范围无效')
    requireValue(consent.acknowledgesExtraCall === true, '路由授权必须确认额外调用费用')
  }
  if (data.deletion !== undefined) {
    requireValue(data.archivedAt !== undefined, '删除记录必须保留存档状态')
    const deletion = object(data.deletion)
    requireValue(deletion.retainedCopies === undefined || typeof deletion.retainedCopies === 'boolean', '共享副本标记无效')
    requireValue((deletion.status === 'pending' || deletion.status === 'complete') && typeof deletion.fingerprint === 'string' && hashPattern.test(deletion.fingerprint), '删除记录无效')
    if (deletion.result !== undefined) {
      const result = object(deletion.result)
      requireValue(typeof result.ok === 'boolean' && ['deleted', 'retained'].every(key => Array.isArray(result[key]) && (result[key] as unknown[]).every(item => typeof item === 'string')) &&
        Array.isArray(result.failed) && result.failed.every(item => typeof object(item).store === 'string' && typeof object(item).error === 'string'), '删除结果无效')
    }
    requireValue(deletion.status !== 'complete' || (object(deletion.result).ok === true && (object(deletion.result).failed as unknown[]).length === 0), '删除未完成，不能标为成功')
  }
  requireValue(Array.isArray(data.bindings) && Array.isArray(data.turns), '对话绑定或轮次无效')
  const bindings = new Map<string, ConversationBinding>()
  const activeTargets = new Set<string>()
  for (const raw of data.bindings) {
    target(raw)
    const binding = object(raw)
    requireValue(typeof binding.id === 'string' && idPattern.test(binding.id) && !bindings.has(binding.id), '对话绑定 ID 无效或重复')
    requireValue(binding.nativeSessionId === undefined || text(binding.nativeSessionId), '原生会话 ID 无效')
    requireValue(binding.historyOnly === undefined || (binding.historyOnly === true && data.fork !== undefined && binding.nativeSessionId === undefined && text(binding.retiredReason)), '只读历史绑定无效')
    requireValue(binding.retiredReason === undefined || (text(binding.retiredReason) && (text(binding.nativeSessionId) || binding.historyOnly === true)), '弃用原生绑定缺少身份或原因')
    if (binding.nativeSessionId !== undefined && binding.retiredReason === undefined) {
      const identity = JSON.stringify([binding.providerId, binding.agentProfileId ?? null, binding.continuationKey])
      requireValue(!activeTargets.has(identity), '同一接续身份存在多个未弃用的原生绑定')
      activeTargets.add(identity)
    }
    bindings.set(binding.id, raw as ConversationBinding)
  }
  if (data.adoptionFingerprint !== undefined) {
    const original = data.bindings[0] as ConversationBinding | undefined
    requireValue(original?.nativeSessionId && original.retiredReason, '迁入源必须保留已弃用的原生归属')
  }
  const runIds = new Set<string>()
  const commandIds = new Set<string>()
  const priorItems: ConversationItemRef[] = []
  for (const [index, raw] of data.turns.entries()) {
    const turn = object(raw)
    requireValue(turn.ordinal === index + 1 && text(turn.runId) && !runIds.has(turn.runId), '对话轮次顺序或 run 身份无效')
    requireValue(typeof turn.bindingId === 'string' && bindings.has(turn.bindingId), '轮次引用了未知原生绑定')
    const binding = bindings.get(turn.bindingId)!
    if (turn.archive !== undefined) {
      const archive = object(turn.archive)
      requireValue(text(archive.sessionId) && (archive.providerTurnId === undefined || text(archive.providerTurnId)), 'App 归档位置无效')
    }
    items(turn.items)
    requireValue(turn.items.every((item) => item.runId === turn.runId), '轮次包含其他 run 的内容')
    if (turn.origin === 'imported') {
      items(turn.nativeItems)
      requireValue((binding.nativeSessionId !== undefined && subset(turn.nativeItems, turn.items)) || (binding.historyOnly === true && turn.nativeItems.length === 0), '导入轮次的原生覆盖无效')
    } else {
      requireValue(turn.origin === 'dispatch', '轮次来源无效')
      requireValue(typeof turn.commandId === 'string' && isCommandId(turn.commandId) && !commandIds.has(turn.commandId), '对话命令 ID 无效或重复')
      commandIds.add(turn.commandId)
      requireValue(typeof turn.intentHash === 'string' && hashPattern.test(turn.intentHash), '对话请求指纹无效')
      requireValue(turn.resumeSessionId === null || (text(turn.resumeSessionId) && turn.resumeSessionId === binding.nativeSessionId), '原生恢复身份不一致')
      items(turn.importedItems)
      items(turn.omittedItems)
      requireValue(turn.historyPolicy === undefined || turn.historyPolicy === 'retrievable-v1', '未知历史交接策略')
      requireValue(turn.importedItems.length > 0 || (turn.historyPolicy === 'retrievable-v1' && turn.omittedItems.length > 0)
        ? isToolContentRef(turn.history) && turn.history.encoding === 'json' && turn.history.bytes <= MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES
        : turn.history === undefined, '交接 intent 缺少正文 artifact 或关联了多余正文')
      requireValue(subset(turn.importedItems, priorItems) && subset(turn.omittedItems, priorItems), '交接引用了不存在或未来的内容')
      const imported = new Set(turn.importedItems.map(conversationItemKey))
      requireValue(turn.omittedItems.every((item) => !imported.has(conversationItemKey(item))), '内容同时被标记为导入和省略')
      const delivery = object(turn.delivery)
      if (delivery.status === 'accepted') {
        requireValue(text(delivery.nativeSessionId) && delivery.nativeSessionId === binding.nativeSessionId, '接收证据与原生会话不一致')
        requireValue(typeof delivery.outcome === 'string' && outcomes.has(delivery.outcome), '缺少真实终态')
        items(delivery.nativeItems)
        requireValue(subset(delivery.nativeItems, turn.items), '原生覆盖超出本轮事实')
      } else if (delivery.status === 'not_sent' || delivery.status === 'unknown') {
        requireValue(text(delivery.reason), '缺少投递结果说明')
      } else requireValue(delivery.status === 'pending', '投递状态无效')
      if (delivery.status === 'pending' || delivery.status === 'unknown') {
        requireValue(index === data.turns.length - 1, '未收敛投递后出现了新轮次')
      }
    }
    runIds.add(turn.runId)
    priorItems.push(...turn.items)
  }
  if (data.fork !== undefined) {
    const fork = object(data.fork)
    requireValue(typeof fork.commandId === 'string' && isCommandId(fork.commandId) && typeof fork.intentHash === 'string' && hashPattern.test(fork.intentHash), '分支命令无效')
    requireValue(typeof fork.sourceConversationId === 'string' && idPattern.test(fork.sourceConversationId) && fork.sourceConversationId !== data.id &&
      Number.isSafeInteger(fork.sourceRevision) && Number(fork.sourceRevision) >= 0 && text(fork.sourceBindingId), '分支来源无效')
    const boundary = (data.turns as ConversationTurn[]).findIndex(turn => turn.runId === fork.sourceRunId)
    requireValue(boundary >= 0 && typeof fork.bindingId === 'string' && bindings.has(fork.bindingId), '分支边界或绑定无效')
    requireValue(['pending', 'accepted', 'unknown', 'not_sent'].includes(String(fork.status)), '分支状态无效')
    requireValue(fork.reason === undefined || text(fork.reason), '分支错误说明无效')
    items(fork.inheritedItems)
    requireValue(subset(fork.inheritedItems, (data.turns as ConversationTurn[]).slice(0, boundary + 1).flatMap(turn => turn.items)), '分支覆盖引用了未来或未知内容')
    requireValue(fork.status !== 'accepted' || Boolean(bindings.get(fork.bindingId)?.nativeSessionId), '原生分支缺少回执身份')
    requireValue(fork.status === 'accepted' || (data.turns as ConversationTurn[]).every(turn => turn.origin === 'imported'), '未确认分支不能追加投递')
    requireValue(fork.status === 'pending' || fork.status === 'accepted' || text(fork.reason), '分支未收敛缺少说明')
  }
  return structuredClone(data) as unknown as Conversation
}

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

export interface BeginConversationTurn {
  expectedRevision: number
  commandId: string
  runId: string
  target: ConversationTarget
  /** Hash of the frozen actual input, attachments and selected run settings. */
  payloadHash: string
  items: ConversationItemRef[]
  selectedItems: ConversationItemRef[]
  /** Already sealed against the same revision; validated before publishing the intent. */
  preparedHistory?: DispatchedConversationTurn['history']
}

export type BeginConversationTurnResult = {
  disposition: 'created' | 'duplicate'
  conversation: Conversation
  turn: DispatchedConversationTurn
}

export interface ConversationIntentInput {
  commandId: string
  target: ConversationTarget
  payloadHash: string
  items: ConversationItemRef[]
  selectedItems: ConversationItemRef[]
}

/** Durable command identity excludes revision/run allocation; retries must find the same attempt. */
export function conversationIntentHash(input: ConversationIntentInput): string {
  return createHash('sha256').update(JSON.stringify({
    commandId: input.commandId,
    target: { providerId: input.target.providerId, agentProfileId: input.target.agentProfileId,
      continuationKey: input.target.continuationKey },
    payloadHash: input.payloadHash,
    items: input.items.map((item) => ({ itemId: item.itemId, contentHash: item.contentHash })),
    selectedItems: input.selectedItems
  })).digest('hex')
}

/** Single main-process owner. No Provider calls, workspace writes or automatic retry occur here. */
export type NativeSessionScope = Pick<ConversationTarget, 'providerId' | 'agentProfileId'> & {
  cwd: string
  nativeSessionId?: string
}
