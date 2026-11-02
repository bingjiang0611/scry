import { isAbsolute } from 'node:path'
import { isCommandId, isAgentPermissionMode } from '../shared/runtime'
import { isToolContentRef } from '../shared/tool-content'
import { sideChatSnapshotRunId, type SideChatInitialTarget, type SideChatOrigin, type SideChatSource } from '../shared/conversation'
import { assertSideChatSnapshotDescriptor } from './conversation-side-chat-manifest'

/** Legacy format 3 only: format 4 keeps items and bodies in manifests instead. */
export const MAX_SIDE_CHAT_SNAPSHOT_BYTES = 4 * 1024 * 1024
export const MAX_SIDE_CHAT_SNAPSHOT_ITEMS = 4000
/** Longest title a source may contribute; also bounds the frozen title copy. */
export const MAX_SIDE_CHAT_TITLE_LENGTH = 200
export const conversationProviderIds = new Set(['claude', 'codex', 'qoder', 'opencode', 'pi'])
export const hashPattern = /^[a-f0-9]{64}$/

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

/**
 * Structural validation only: any of the five Providers may be requested, while
 * whether a Provider can actually receive the snapshot on send is a capability
 * check made by the caller against the live registry.
 */
export function sideChatInitialTarget(value: unknown): asserts value is SideChatInitialTarget {
  const target = object(value)
  requireValue(Object.keys(target).every(key =>
    ['providerId', 'agentProfileId', 'model', 'effort', 'permissionMode'].includes(key)), '侧聊初始目标字段不受支持')
  requireValue(typeof target.providerId === 'string' && conversationProviderIds.has(target.providerId), '侧聊初始目标 Provider 无效')
  requireValue(target.agentProfileId === undefined || text(target.agentProfileId), '侧聊初始目标 Profile 无效')
  requireValue(target.effort === undefined || (text(target.effort) && target.effort.length <= 240), '侧聊初始目标 effort 无效')
  requireValue(target.permissionMode === undefined || isAgentPermissionMode(target.permissionMode), '侧聊初始目标权限模式无效')
  if (target.model !== undefined) {
    const model = object(target.model)
    requireValue(Object.keys(model).every(key => ['id', 'providerId'].includes(key)), '侧聊初始目标模型字段不受支持')
    requireValue(text(model.id) && model.id.length <= 240, '侧聊初始目标模型无效')
    requireValue(model.providerId === undefined || (text(model.providerId) && model.providerId.length <= 240), '侧聊初始目标模型 Provider 无效')
  }
}

/** Source identity of a side chat; content read through it is data, never authorization. */
export function sideChatSource(value: unknown): asserts value is SideChatSource {
  const source = object(value)
  if (source.kind === 'conversation') {
    requireValue(typeof source.conversationId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(source.conversationId),
      '侧聊来源对话 ID 无效')
    requireValue(Object.keys(source).length === 2, '侧聊来源字段不受支持')
    return
  }
  requireValue(source.kind === 'native-session', '侧聊来源类型不受支持')
  requireValue(Object.keys(source).every(key => ['kind', 'providerId', 'agentProfileId', 'cwd', 'nativeSessionId'].includes(key)), '侧聊来源字段不受支持')
  requireValue(typeof source.providerId === 'string' && conversationProviderIds.has(source.providerId), '侧聊来源 Provider 无效')
  requireValue(source.agentProfileId === undefined || text(source.agentProfileId), '侧聊来源 Profile 无效')
  requireValue(typeof source.cwd === 'string' && isAbsolute(source.cwd), '侧聊来源工作区必须是绝对路径')
  requireValue(text(source.nativeSessionId), '侧聊来源缺少原生会话身份')
}

function snapshot(value: unknown): asserts value is SideChatOrigin['snapshot'] {
  const frozen = object(value)
  // Format 4 keeps the item list and message bodies in content-addressed manifests, so
  // the record is a descriptor; its counts, binding and bounds are checked there.
  if (frozen.format === 4) {
    assertSideChatSnapshotDescriptor(frozen)
    return
  }
  requireValue(Object.keys(frozen).every(key =>
    ['id', 'prefixFingerprint', 'throughOrdinal', 'throughRunId', 'capturedAt', 'content', 'items'].includes(key)), '侧聊快照字段不受支持')
  requireValue(typeof frozen.id === 'string' && /^[a-f0-9-]{36}$/i.test(frozen.id), '侧聊快照 ID 无效')
  requireValue(typeof frozen.prefixFingerprint === 'string' && hashPattern.test(frozen.prefixFingerprint), '侧聊前缀指纹无效')
  requireValue(Number.isSafeInteger(frozen.throughOrdinal) && Number(frozen.throughOrdinal) > 0, '侧聊快照截止轮次无效')
  requireValue(text(frozen.throughRunId), '侧聊快照截止轮次缺少运行身份')
  requireValue(Number.isSafeInteger(frozen.capturedAt) && Number(frozen.capturedAt) > 0, '侧聊快照冻结时间无效')
  requireValue(isToolContentRef(frozen.content) && frozen.content.encoding === 'json' &&
    frozen.content.bytes > 0 && frozen.content.bytes <= MAX_SIDE_CHAT_SNAPSHOT_BYTES, '侧聊快照正文引用无效')
  requireValue(Array.isArray(frozen.items) && frozen.items.length > 0 &&
    frozen.items.length <= MAX_SIDE_CHAT_SNAPSHOT_ITEMS, '侧聊快照消息数量无效')
  let previousOrdinal = 0
  const keys = new Set<string>()
  const snapshotId = String(frozen.id)
  for (const [index, raw] of frozen.items.entries()) {
    const item = object(raw)
    requireValue(Object.keys(item).every(key => ['ref', 'sourceOrdinal', 'providerId', 'role'].includes(key)), '侧聊快照字段不受支持')
    const ref = object(item.ref)
    requireValue(Object.keys(ref).every(key => ['runId', 'itemId', 'contentHash'].includes(key)) &&
      ref.runId === sideChatSnapshotRunId(snapshotId, index) &&
      (item.role === 'user' || item.role === 'assistant') && ref.itemId === item.role &&
      typeof ref.contentHash === 'string' && hashPattern.test(ref.contentHash), '侧聊快照消息引用无效')
    requireValue(typeof item.providerId === 'string' && conversationProviderIds.has(item.providerId), '侧聊快照消息 Provider 无效')
    requireValue(Number.isSafeInteger(item.sourceOrdinal) && Number(item.sourceOrdinal) >= previousOrdinal &&
      Number(item.sourceOrdinal) > 0, '侧聊快照消息顺序无效')
    previousOrdinal = Number(item.sourceOrdinal)
    const key = JSON.stringify([ref.runId, ref.itemId, ref.contentHash])
    requireValue(!keys.has(key), '侧聊快照消息引用重复')
    keys.add(key)
  }
  requireValue(previousOrdinal === Number(frozen.throughOrdinal), '侧聊快照截止轮次与消息不一致')
}

export function sideChatOrigin(value: unknown, id: string, cwd: string): asserts value is SideChatOrigin {
  const origin = object(value)
  requireValue(Object.keys(origin).every(key =>
    ['source', 'parentTitleAtCapture', 'initialTarget', 'snapshot', 'commandId', 'intentHash'].includes(key)), '侧聊来源字段不受支持')
  sideChatSource(origin.source)
  requireValue(typeof origin.commandId === 'string' && isCommandId(origin.commandId), '侧聊创建命令无效')
  requireValue(typeof origin.intentHash === 'string' && hashPattern.test(origin.intentHash), '侧聊创建意图指纹无效')
  requireValue(text(origin.parentTitleAtCapture) && origin.parentTitleAtCapture.length <= MAX_SIDE_CHAT_TITLE_LENGTH, '侧聊来源标题无效')
  sideChatInitialTarget(origin.initialTarget)
  const source = origin.source as SideChatSource
  if (source.kind === 'conversation') requireValue(source.conversationId !== id, '侧聊不能以自身为来源')
  else requireValue(source.cwd === cwd, '侧聊工作区必须与冻结来源一致')
  snapshot(origin.snapshot)
}
