import type {
  ConversationForkRequest, ConversationSendRequest, ConversationSideChatRequest, ConversationTargetRequest,
  SideChatListRequest, SideChatPreviewOptions
} from '../shared/conversation-api'
import type { SideChatInitialTarget, SideChatSource } from '../shared/conversation'
import { boundedControlValue, isAgentPermissionMode, isCommandId, normalizeAgentAttachments, type AgentStartRequest } from '../shared/runtime'
import { assertConversationItems, hashPattern, sideChatInitialTarget, sideChatSource } from './conversation-schema'

export const targetFields = ['providerId', 'agentProfileId', 'model', 'effort', 'permissionMode']

export function requestObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
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
  if (value.providerId !== 'claude' && value.providerId !== 'codex' && value.providerId !== 'pi' &&
    value.providerId !== 'qoder' && value.providerId !== 'opencode') throw new Error('统一对话 Provider 不受支持')
  if (value.providerId === 'pi') {
    if (typeof value.agentProfileId !== 'string' || !/^pi:[a-f0-9]{16}$/.test(value.agentProfileId)) {
      throw new Error('统一对话 Pi 必须选择已登记的 Agent Profile')
    }
  } else if (value.agentProfileId !== undefined) throw new Error('统一对话仅支持 Pi 命名 Profile；其他 Provider 仅支持默认配置')
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

export function parseSend(input: unknown): ConversationSendRequest {
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

export function parseConversationFork(input: unknown): ConversationForkRequest {
  const value = requestObject(input, ['conversationId', 'sourceRunId', 'expectedRevision', 'commandId', 'permissionMode'])
  if (typeof value.conversationId !== 'string' || typeof value.sourceRunId !== 'string' || !value.sourceRunId ||
    !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 || typeof value.commandId !== 'string' || !isCommandId(value.commandId) ||
    (value.permissionMode !== undefined && !isAgentPermissionMode(value.permissionMode))) throw new Error('分支请求无效')
  return { conversationId: value.conversationId, sourceRunId: value.sourceRunId,
    expectedRevision: Number(value.expectedRevision), commandId: value.commandId,
    permissionMode: value.permissionMode as AgentStartRequest['permissionMode'] ?? 'default' }
}

/** Read-only source: a Scry conversation or a verified native session scope. */
export function parseSideChatSource(input: unknown): SideChatSource {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('侧聊来源请求无效')
  sideChatSource(input)
  const source = structuredClone(input as SideChatSource)
  if (source.kind === 'native-session' && !source.nativeSessionId.trim()) throw new Error('侧聊来源缺少原生会话身份')
  return source
}

/** A requested first-send choice; whether the Provider can receive it is a capability check. */
function parseInitialTarget(value: unknown): SideChatInitialTarget {
  sideChatInitialTarget(value)
  const target = value as SideChatInitialTarget
  if (typeof target.providerId !== 'string') throw new Error('侧聊初始目标 Provider 无效')
  return structuredClone(target)
}

export function parseSideChatPreviewOptions(input: unknown): SideChatPreviewOptions {
  if (input === undefined) return {}
  const value = requestObject(input, ['completedThroughOrdinal', 'initialTarget'])
  if (value.completedThroughOrdinal !== undefined && (!Number.isSafeInteger(value.completedThroughOrdinal) ||
    Number(value.completedThroughOrdinal) <= 0)) throw new Error('侧聊预览截止轮次无效')
  return {
    ...(value.completedThroughOrdinal === undefined ? {} : { completedThroughOrdinal: Number(value.completedThroughOrdinal) }),
    ...(value.initialTarget === undefined ? {} : { initialTarget: parseInitialTarget(value.initialTarget) })
  }
}

export function parseSideChatListRequest(input: unknown): SideChatListRequest {
  const value = requestObject(input, ['source', 'cursor', 'limit', 'ids'])
  const source = parseSideChatSource(value.source)
  if (value.cursor !== undefined && typeof value.cursor !== 'string') throw new Error('侧聊历史游标无效')
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100)) {
    throw new Error('侧聊历史分页大小必须在 1 到 100 之间')
  }
  if (value.ids !== undefined && (!Array.isArray(value.ids) || value.ids.length < 1 || value.ids.length > 8 ||
    !value.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128))) {
    // The selected-id lookup exists to validate a restored tab strip of at most eight
    // children; anything larger is a listing request, not a lookup.
    throw new Error('侧聊摘要查询一次最多 8 个 ID')
  }
  return { source, ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    ...(value.limit === undefined ? {} : { limit: Number(value.limit) }),
    ...(value.ids === undefined ? {} : { ids: value.ids as string[] }) }
}

export function parseSideChatCreate(input: unknown): ConversationSideChatRequest {
  const value = requestObject(input, ['source', 'expectedThroughOrdinal', 'expectedThroughRunId',
    'expectedPrefixFingerprint', 'expectedManifestFingerprint', 'commandId', 'initialTarget'])
  const source = parseSideChatSource(value.source)
  if (!Number.isSafeInteger(value.expectedThroughOrdinal) || Number(value.expectedThroughOrdinal) <= 0 ||
    typeof value.expectedThroughRunId !== 'string' || !value.expectedThroughRunId ||
    typeof value.expectedPrefixFingerprint !== 'string' || !hashPattern.test(value.expectedPrefixFingerprint) ||
    typeof value.expectedManifestFingerprint !== 'string' || !hashPattern.test(value.expectedManifestFingerprint) ||
    typeof value.commandId !== 'string' || !isCommandId(value.commandId)) throw new Error('侧聊创建参数无效')
  return { source, expectedThroughOrdinal: Number(value.expectedThroughOrdinal), expectedThroughRunId: value.expectedThroughRunId,
    expectedPrefixFingerprint: value.expectedPrefixFingerprint, expectedManifestFingerprint: value.expectedManifestFingerprint,
    commandId: value.commandId,
    ...(value.initialTarget === undefined ? {} : { initialTarget: parseInitialTarget(value.initialTarget) }) }
}
