import { providerIdForAgentId, type AgentRunControls } from '@shared/runtime'
import type { ConversationAdoptionPreview, ConversationApi, ConversationSendRequest, ConversationSummary, ConversationTargetRequest } from '@shared/conversation-api'

export function conversationTarget(agentId: string, controls?: AgentRunControls): ConversationTargetRequest {
  const providerId = providerIdForAgentId(agentId)
  if (providerId !== 'claude' && providerId !== 'codex' && providerId !== 'pi') {
    throw new Error('此 Agent 尚不支持跨 Agent 接续；当前对话和草稿已保留')
  }
  return {
    providerId,
    ...(providerId === 'pi' ? { agentProfileId: agentId } : {}),
    ...controls
  }
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
  commandId: string
): Promise<ConversationSendRequest> {
  const captured = structuredClone(target)
  const preview = await api.preview(conversationId, captured)
  if (preview.continuation.kind === 'blocked') throw new Error(preview.continuation.reason)
  return {
    ...captured,
    conversationId,
    expectedRevision: preview.revision,
    expectedContinuationKey: preview.target.continuationKey,
    commandId,
    prompt,
    selectedItems: preview.missingItems.map(item => item.ref),
    // Choosing an Agent and pressing Send authorizes its context. Nothing is
    // launched by menu selection; unknown attempts retain this exact command.
    confirmFresh: true
  }
}
