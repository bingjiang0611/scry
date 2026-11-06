import { isPiAgentProfileId, providerIdForAgentId, type AgentInputAttachment, type AgentRunControls } from '@shared/runtime'
import type { ConversationAdoptionPreview, ConversationApi, ConversationSendRequest, ConversationSummary, ConversationTargetRequest } from '@shared/conversation-api'
import { CONVERSATION_COPY } from './constants/conversation-copy'

/** What discovery reported for one Agent: its own id, display name and registered Pi profile. */
export interface AgentProfileIdentity {
  id: string
  agentProfileId?: string
  name?: string
}

/** The name the menus show for this Agent; the raw id is only the last resort. */
const agentLabelOf = (agentId: string, agents: readonly AgentProfileIdentity[]): string =>
  agents.find(agent => agent.id === agentId)?.name ?? agentId

/**
 * Registered Pi Agent Profile identity of the selected Agent.
 *
 * Discovery keeps historical ids such as `pi:rotom` so saved native sessions resolve, but
 * a conversation send must name a registered profile. Only the exact selected Agent may
 * supply it: another Pi launcher is a different identity, so a same-Provider neighbour is
 * never substituted. `undefined` means this selection cannot be sent.
 */
export function registeredPiProfileIdOf(agentId: string, agents: readonly AgentProfileIdentity[]): string | undefined {
  if (isPiAgentProfileId(agentId)) return agentId
  const agentProfileId = agents.find(agent => agent.id === agentId)?.agentProfileId
  return isPiAgentProfileId(agentProfileId) ? agentProfileId : undefined
}

/** The Agent Profile identity a new run records for the selected Agent. */
export function selectedAgentProfileId(agentId: string, agents: readonly AgentProfileIdentity[]): string | undefined {
  return providerIdForAgentId(agentId) === 'pi' ? registeredPiProfileIdOf(agentId, agents) : agentId
}

/**
 * Send target of the clicked Agent. Every registered Provider owns its own native
 * continuation, so the send contract is the five-Provider one; a Provider that is not
 * registered at all is refused instead of being silently mapped onto another one.
 */
export function conversationTarget(agentId: string, controls?: AgentRunControls,
  agents: readonly AgentProfileIdentity[] = []): ConversationTargetRequest {
  const providerId = providerIdForAgentId(agentId)
  if (!providerId) throw new Error(`Agent ${agentId} 尚未注册 Provider adapter；当前对话和草稿已保留`)
  if (providerId !== 'pi') return { providerId, ...controls }
  const agentProfileId = registeredPiProfileIdOf(agentId, agents)
  // A historical Pi id is not an Agent Profile. Sending it would be refused by the host
  // anyway, so say so here, before any read, and never pick a neighbour launcher.
  if (!agentProfileId) throw new Error(CONVERSATION_COPY.piProfileNotRegistered(agentLabelOf(agentId, agents)))
  return { providerId, agentProfileId, ...controls }
}

/**
 * Adoption source of the legacy capture entry. It is deliberately narrower than the send
 * target: only these three Providers keep an adoptable captured archive. Widening it here
 * would promise a migration the host refuses, and narrowing the send target would deny
 * Qoder/OpenCode their own real native continuation.
 */
export function legacyAdoptionSourceTarget(agentId: string): ConversationTargetRequest & { providerId: 'claude' | 'codex' | 'pi' } {
  // The source is the identity the native session was captured under, so it cannot be
  // rewritten to a registered profile: the host matches it against the recorded session.
  if (providerIdForAgentId(agentId) === 'pi' && !isPiAgentProfileId(agentId)) {
    throw new Error(CONVERSATION_COPY.legacyPiSourceNotMigratable(agentId))
  }
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
