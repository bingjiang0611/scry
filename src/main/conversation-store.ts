import { createHash, randomUUID } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ContextAdmission } from './context-admission'
import { writeFileAtomicExclusive, writeJsonAtomic } from '../core/turn-recorder/io'
import { isCommandId } from '../shared/runtime'
import {
  conversationItemKey,
  planConversationContinuation,
  sameConversationTarget,
  type Conversation,
  type ConversationBinding,
  type ConversationDelivery,
  type ConversationItemRef,
  type ConversationTarget,
  type ConversationTurn,
  type DispatchedConversationTurn
} from '../shared/conversation'

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const hashPattern = /^[a-f0-9]{64}$/
const providers = new Set(['claude', 'codex', 'qoder', 'opencode', 'pi'])
const outcomes = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const maxBytes = 16 * 1024 * 1024

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), '对话记录必须是对象')
  return value as Record<string, unknown>
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
function target(value: unknown): asserts value is ConversationTarget {
  const data = object(value)
  requireValue(typeof data.providerId === 'string' && providers.has(data.providerId), '对话 Provider 无效')
  requireValue(data.agentProfileId === undefined || text(data.agentProfileId), '对话 Profile 无效')
  requireValue(text(data.continuationKey), '缺少原生接续兼容身份')
}
function items(value: unknown): asserts value is ConversationItemRef[] {
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
function subset(selected: ConversationItemRef[], available: ConversationItemRef[]): boolean {
  const keys = new Set(available.map(conversationItemKey))
  return selected.every((item) => keys.has(conversationItemKey(item)))
}

/** Decode persisted state before using any identity or coverage. Corruption is not empty history. */
export function decodeConversation(value: unknown): Conversation {
  const data = object(value)
  requireValue(data.version === 1 && typeof data.id === 'string' && idPattern.test(data.id), '对话版本或 ID 无效')
  requireValue(typeof data.cwd === 'string' && isAbsolute(data.cwd), '对话工作区必须是绝对路径')
  requireValue(Number.isSafeInteger(data.revision) && Number(data.revision) >= 0, '对话 revision 无效')
  requireValue(Array.isArray(data.bindings) && Array.isArray(data.turns), '对话绑定或轮次无效')
  const bindings = new Map<string, ConversationBinding>()
  const activeTargets = new Set<string>()
  for (const raw of data.bindings) {
    target(raw)
    const binding = object(raw)
    requireValue(typeof binding.id === 'string' && idPattern.test(binding.id) && !bindings.has(binding.id), '对话绑定 ID 无效或重复')
    requireValue(binding.nativeSessionId === undefined || text(binding.nativeSessionId), '原生会话 ID 无效')
    requireValue(binding.retiredReason === undefined || (text(binding.retiredReason) && text(binding.nativeSessionId)), '弃用原生绑定缺少身份或原因')
    if (binding.nativeSessionId !== undefined && binding.retiredReason === undefined) {
      const identity = JSON.stringify([binding.providerId, binding.agentProfileId ?? null, binding.continuationKey])
      requireValue(!activeTargets.has(identity), '同一接续身份存在多个未弃用的原生绑定')
      activeTargets.add(identity)
    }
    bindings.set(binding.id, raw as ConversationBinding)
  }
  const runIds = new Set<string>()
  const commandIds = new Set<string>()
  const priorItems: ConversationItemRef[] = []
  for (const [index, raw] of data.turns.entries()) {
    const turn = object(raw)
    requireValue(turn.ordinal === index + 1 && text(turn.runId) && !runIds.has(turn.runId), '对话轮次顺序或 run 身份无效')
    requireValue(typeof turn.bindingId === 'string' && bindings.has(turn.bindingId), '轮次引用了未知原生绑定')
    const binding = bindings.get(turn.bindingId)!
    items(turn.items)
    requireValue(turn.items.every((item) => item.runId === turn.runId), '轮次包含其他 run 的内容')
    if (turn.origin === 'imported') {
      items(turn.nativeItems)
      requireValue(binding.nativeSessionId !== undefined && subset(turn.nativeItems, turn.items), '导入轮次的原生覆盖无效')
    } else {
      requireValue(turn.origin === 'dispatch', '轮次来源无效')
      requireValue(typeof turn.commandId === 'string' && isCommandId(turn.commandId) && !commandIds.has(turn.commandId), '对话命令 ID 无效或重复')
      commandIds.add(turn.commandId)
      requireValue(typeof turn.intentHash === 'string' && hashPattern.test(turn.intentHash), '对话请求指纹无效')
      requireValue(turn.resumeSessionId === null || (text(turn.resumeSessionId) && turn.resumeSessionId === binding.nativeSessionId), '原生恢复身份不一致')
      items(turn.importedItems)
      items(turn.omittedItems)
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
  return structuredClone(data) as unknown as Conversation
}

export interface ConversationSeed {
  target: ConversationTarget
  nativeSessionId: string
  /** Authoritative existing turns only; this imports references, never clones trace/usage rows. */
  turns: Array<{ runId: string; items: ConversationItemRef[]; nativeItems: ConversationItemRef[] }>
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
}

export type BeginConversationTurnResult = {
  disposition: 'created' | 'duplicate'
  conversation: Conversation
  turn: DispatchedConversationTurn
}

/** Single main-process owner. No Provider calls, workspace writes or automatic retry occur here. */
export class ConversationStore {
  private readonly admission = new ContextAdmission()
  private readonly directory: string

  constructor(userData: string) {
    requireValue(isAbsolute(userData), 'userData 必须是绝对路径')
    this.directory = join(userData, 'conversations')
  }

  private path(id: string): string {
    requireValue(idPattern.test(id), '对话 ID 无效')
    return join(this.directory, `${id}.json`)
  }

  async read(id: string): Promise<Conversation | null> {
    let handle
    try {
      handle = await open(this.path(id), 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      // Store files are immutable after publication; all writes replace them atomically.
      requireValue((await handle.stat()).size <= maxBytes, '对话索引超过 16 MiB 上限')
      const conversation = decodeConversation(JSON.parse(await handle.readFile('utf8')))
      requireValue(conversation.id === id, '对话文件与内容身份不一致')
      return conversation
    } finally {
      await handle.close()
    }
  }

  private checked(value: Conversation): Conversation {
    const decoded = decodeConversation(value)
    requireValue(Buffer.byteLength(JSON.stringify(decoded)) + 1 <= maxBytes, '对话索引超过 16 MiB 上限')
    return decoded
  }

  private async required(id: string): Promise<Conversation> {
    const conversation = await this.read(id)
    requireValue(conversation !== null, '找不到对话，不会自动创建空历史')
    return conversation
  }

  async create(cwd: string, seed?: ConversationSeed): Promise<Conversation> {
    const initial = seed ? structuredClone(seed) : undefined
    const canonical = await realpath(cwd)
    requireValue((await stat(canonical)).isDirectory(), '对话工作区不是目录')
    const bindings: ConversationBinding[] = initial
      ? [{ ...initial.target, id: randomUUID(), nativeSessionId: initial.nativeSessionId }]
      : []
    const turns: ConversationTurn[] = initial ? initial.turns.map((turn, index) => ({
      ...turn, ordinal: index + 1, bindingId: bindings[0].id, origin: 'imported'
    })) : []
    const conversation = this.checked({ version: 1, id: randomUUID(), cwd: canonical, revision: 0, bindings, turns })
    await writeFileAtomicExclusive(this.path(conversation.id), Buffer.from(`${JSON.stringify(conversation)}\n`))
    return conversation
  }

  async begin(id: string, input: BeginConversationTurn): Promise<BeginConversationTurnResult> {
    // Freeze caller-owned objects before waiting in the queue.
    const request = structuredClone(input)
    return this.admission.run(id, async () => {
      target(request.target)
      requireValue(typeof request.payloadHash === 'string' && hashPattern.test(request.payloadHash), '输入指纹无效')
      requireValue(isCommandId(request.commandId), '对话命令 ID 无效')
      items(request.items)
      items(request.selectedItems)
      const intentHash = createHash('sha256').update(JSON.stringify({
        expectedRevision: request.expectedRevision, commandId: request.commandId, runId: request.runId,
        target: { providerId: request.target.providerId, agentProfileId: request.target.agentProfileId,
          continuationKey: request.target.continuationKey },
        payloadHash: request.payloadHash, items: request.items, selectedItems: request.selectedItems
      })).digest('hex')
      const conversation = await this.required(id)
      const existing = conversation.turns.find((turn) => turn.origin === 'dispatch' && turn.commandId === request.commandId)
      if (existing?.origin === 'dispatch') {
        requireValue(existing.intentHash === intentHash, '同一命令 ID 不能替换请求内容或目标')
        return { disposition: 'duplicate', conversation, turn: existing }
      }
      requireValue(conversation.revision === request.expectedRevision, '对话已变化，请重新预览')
      const plan = planConversationContinuation(conversation, request.target)
      if (plan.kind === 'blocked') throw new Error(plan.reason)
      const order = new Map(plan.missingItems.map((item, index) => [conversationItemKey(item), index]))
      let previous = -1
      for (const item of request.selectedItems) {
        const position = order.get(conversationItemKey(item))
        requireValue(position !== undefined && position > previous, '交接选择不属于当前缺失历史，或顺序已变化')
        previous = position
      }
      const bindingId = plan.kind === 'resume' ? plan.bindingId : randomUUID()
      if (plan.kind === 'fresh') conversation.bindings.push({ ...request.target, id: bindingId })
      const selected = new Set(request.selectedItems.map(conversationItemKey))
      const turn: DispatchedConversationTurn = {
        origin: 'dispatch', ordinal: conversation.turns.length + 1, runId: request.runId, bindingId,
        items: request.items, commandId: request.commandId, intentHash,
        resumeSessionId: plan.kind === 'resume' ? plan.nativeSessionId : null,
        importedItems: request.selectedItems,
        omittedItems: plan.missingItems.filter((item) => !selected.has(conversationItemKey(item))),
        delivery: { status: 'pending' }
      }
      conversation.turns.push(turn)
      conversation.revision++
      const checked = this.checked(conversation)
      await writeJsonAtomic(this.path(id), checked)
      return { disposition: 'created', conversation: checked, turn: structuredClone(turn) }
    })
  }

  async settle(
    id: string,
    runId: string,
    result: Exclude<ConversationDelivery, { status: 'pending' }>,
    finalItems: ConversationItemRef[]
  ): Promise<Conversation> {
    const delivery = structuredClone(result)
    const final = structuredClone(finalItems)
    return this.admission.run(id, async () => {
      const conversation = await this.required(id)
      const turn = conversation.turns.find((candidate) => candidate.runId === runId)
      requireValue(turn?.origin === 'dispatch', '找不到该投递尝试')
      if (JSON.stringify(turn.delivery) === JSON.stringify(delivery) && JSON.stringify(turn.items) === JSON.stringify(final)) {
        return conversation
      }
      requireValue(turn.delivery.status === 'pending' || turn.delivery.status === 'unknown', '不能改写已经确认的投递结果')
      items(final)
      requireValue(subset(turn.items, final), '不能改写已冻结的本轮输入引用')
      if (delivery.status === 'accepted') {
        const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)!
        requireValue(binding.nativeSessionId === undefined || binding.nativeSessionId === delivery.nativeSessionId, 'Provider 返回了不同的原生会话；拒绝沿用旧覆盖')
        if (turn.resumeSessionId === null) {
          const reused = conversation.bindings.some((candidate) => candidate.id !== binding.id &&
            sameConversationTarget(candidate, binding) && candidate.nativeSessionId === delivery.nativeSessionId)
          requireValue(!reused, 'Provider 复用了旧原生身份，不能标记为新建上下文')
        }
        binding.nativeSessionId = delivery.nativeSessionId
      }
      turn.items = final
      turn.delivery = delivery
      conversation.revision++
      const checked = this.checked(conversation)
      await writeJsonAtomic(this.path(id), checked)
      return checked
    })
  }

  /** Main must first verify native ownership and obtain the user's explicit replacement choice. */
  async retireBinding(id: string, expectedRevision: number, bindingId: string, reason: string): Promise<Conversation> {
    return this.admission.run(id, async () => {
      requireValue(text(reason), '弃用原生绑定必须说明原因')
      const conversation = await this.required(id)
      requireValue(conversation.revision === expectedRevision, '对话已变化，请重新预览')
      const binding = conversation.bindings.find((candidate) => candidate.id === bindingId)
      requireValue(binding?.nativeSessionId !== undefined, '找不到可弃用的原生绑定')
      const plan = planConversationContinuation(conversation, binding)
      if (plan.kind === 'blocked') throw new Error(plan.reason)
      requireValue(binding.retiredReason === undefined, '该原生绑定已经弃用')
      binding.retiredReason = reason
      conversation.revision++
      const checked = this.checked(conversation)
      await writeJsonAtomic(this.path(id), checked)
      return checked
    })
  }

  /** Startup barrier only: new begin/Provider registration must wait until recovery completes. */
  async recover(id: string, liveRunIds: ReadonlySet<string>): Promise<Conversation> {
    const live = new Set(liveRunIds)
    return this.admission.run(id, async () => {
      const conversation = await this.required(id)
      let changed = false
      for (const turn of conversation.turns) {
        if (turn.origin !== 'dispatch' || turn.delivery.status !== 'pending' || live.has(turn.runId)) continue
        turn.delivery = { status: 'unknown', reason: '未找到活动 owner，且缺少原生投递确认；不会自动重发' }
        changed = true
      }
      if (!changed) return conversation
      conversation.revision++
      const checked = this.checked(conversation)
      await writeJsonAtomic(this.path(id), checked)
      return checked
    })
  }
}
