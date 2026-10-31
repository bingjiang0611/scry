import { providerIdForAgentId, type AgentInputAttachment, type AgentRunControls } from '@shared/runtime'
import type { ConversationAdoptionPreview, ConversationApi, ConversationSendRequest, ConversationSummary, ConversationTargetRequest } from '@shared/conversation-api'

/**
 * Send target of the clicked Agent. Every registered Provider owns its own native
 * continuation, so the send contract is the five-Provider one; a Provider that is not
 * registered at all is refused instead of being silently mapped onto another one.
 */
export function conversationTarget(agentId: string, controls?: AgentRunControls): ConversationTargetRequest {
  const providerId = providerIdForAgentId(agentId)
  if (!providerId) throw new Error(`Agent ${agentId} 尚未注册 Provider adapter；当前对话和草稿已保留`)
  return {
    providerId,
    ...(providerId === 'pi' ? { agentProfileId: agentId } : {}),
    ...controls
  }
}

/**
 * Adoption source of the legacy capture entry. It is deliberately narrower than the send
 * target: only these three Providers keep an adoptable captured archive. Widening it here
 * would promise a migration the host refuses, and narrowing the send target would deny
 * Qoder/OpenCode their own real native continuation.
 */
export function legacyAdoptionSourceTarget(agentId: string): ConversationTargetRequest & { providerId: 'claude' | 'codex' | 'pi' } {
  const target = conversationTarget(agentId)
  if (target.providerId !== 'claude' && target.providerId !== 'codex' && target.providerId !== 'pi') {
    throw new Error('旧捕获的迁移来源仅支持 Claude/Codex/Pi；可改用侧边会话或分支，当前对话和草稿已保留')
  }
  return { ...target, providerId: target.providerId }
}

/** Never replay an adoption after an unknown IPC result; read the original ownership. */
export async function adoptConversationWithReadback(
  api: Pick<ConversationApi, 'adopt' | 'previewAdoption'>,
  preview: ConversationAdoptionPreview
): Promise<ConversationSummary> {
  if (preview.adoptedConversation) return preview.adoptedConversation
  try { return await api.adopt(preview.source, preview.fingerprint) } catch (error) {
    let readback: ConversationAdoptionPreview
    try { readback = await api.previewAdoption(preview.source) } catch (readError) {
      throw new Error(`切换结果未知，草稿保留；请恢复连接后重新选择 Agent 核对。${String(error)}；核对失败：${String(readError)}`)
    }
    if (readback.fingerprint === preview.fingerprint && readback.adoptedConversation) return readback.adoptedConversation
    throw error
  }
}

/** Plan at the user's send action. Selecting an Agent never dispatches input. */
export async function prepareConversationSend(
  api: Pick<ConversationApi, 'preview'>,
  conversationId: string,
  target: ConversationTargetRequest,
  prompt: string,
  commandId: string,
  attachments: AgentInputAttachment[] = []
): Promise<ConversationSendRequest> {
  const captured = structuredClone(target)
  const capturedAttachments = structuredClone(attachments)
  const preview = await api.preview(conversationId, captured)
  if (preview.continuation.kind === 'blocked') throw new Error(preview.continuation.reason)
  return {
    ...captured,
    conversationId,
    expectedRevision: preview.revision,
    expectedContinuationKey: preview.target.continuationKey,
    commandId,
    prompt,
    ...(capturedAttachments.length ? { attachments: capturedAttachments } : {}),
    selectedItems: preview.missingItems.map(item => item.ref),
    // Choosing an Agent and pressing Send authorizes its context. Nothing is
    // launched by menu selection; unknown attempts retain this exact command.
    confirmFresh: true
  }
}
