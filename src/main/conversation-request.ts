import type { ConversationSendRequest, ConversationTargetRequest } from '../shared/conversation-api'
import { boundedControlValue, isAgentPermissionMode, isCommandId, normalizeAgentAttachments } from '../shared/runtime'
import { assertConversationItems } from './conversation-store'
import { taskSubmissionCopy as copy } from '../shared/constants/copy'

const targetFields = ['providerId', 'agentProfileId', 'model', 'effort', 'permissionMode']

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

export function assertPlainConversationInput(request: ConversationSendRequest): void {
  if (!request.prompt.trim() && !request.attachments?.length) throw new Error(copy.emptyInput)
  if (/^\s*\//.test(request.prompt)) throw new Error(copy.unsupportedSlash)
}

export function parseConversationSend(input: unknown): ConversationSendRequest {
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
