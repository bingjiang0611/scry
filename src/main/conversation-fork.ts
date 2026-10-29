import { createHash } from 'node:crypto'
import type { ConversationForkRequest, ConversationSummary } from '../shared/conversation-api'
import type { ConversationServiceDeps } from './conversation-service'
import { conversationSummary } from './conversation-summary'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * Native fork: the Provider confirms a new native branch. This is not a side-chat
 * snapshot, and it never rewrites the source conversation's turns.
 */
export async function forkConversation(
  deps: ConversationServiceDeps,
  active: ReadonlySet<string>,
  request: ConversationForkRequest
): Promise<ConversationSummary> {
  const intentHash = hash(JSON.stringify(request))
  const existing = await deps.store.findFork(request.conversationId, request.commandId)
  if (existing) {
    if (existing.fork!.intentHash !== intentHash) throw new Error('同一分支命令不能替换内容')
    return conversationSummary(existing, active)
  }
  if (!deps.forkNative) throw new Error('原生分支不可用')
  const source = await deps.store.read(request.conversationId)
  // A side chat keeps its inherited messages in its own frozen snapshot, not in
  // `turns`; a native fork would publish a child whose inherited context silently
  // lost that body. Nested side chats are not supported, so refuse before any
  // Provider call or ledger publication.
  if (source?.sideChat) throw new Error('侧聊不能作为原生分支的来源；不支持嵌套侧聊')
  const turn = source?.turns.find(item => item.runId === request.sourceRunId)
  const binding = source?.bindings.find(item => item.id === turn?.bindingId)
  if (!source || !turn || !binding?.nativeSessionId || binding.retiredReason) throw new Error('该轮缺少可验证的原生分支归属')
  const context = { providerId: binding.providerId, agentProfileId: binding.agentProfileId, cwd: source.cwd }
  const verifyIdentity = async (): Promise<void> => {
    if (await deps.resolveContinuationKey(context) !== binding.continuationKey) throw new Error('源 Agent 接续身份已变化，不能创建原生分支')
  }
  await verifyIdentity()
  const begun = await deps.store.beginFork(source.id, { ...request, intentHash })
  if (!begun.created) return conversationSummary(begun.conversation, active)
  let attempting = false
  try {
    const nativeSessionId = await deps.forkNative({ source, binding, turn, permissionMode: request.permissionMode, beforeFork: async () => {
      await verifyIdentity()
      await deps.store.assertManagedWriteAllowed({ conversationId: source.id, cwd: source.cwd, target: binding, nativeSessionId: binding.nativeSessionId })
      attempting = true
    } })
    if (!attempting) {
      attempting = true
      throw new Error('Provider 未遵守原生分支投递边界，结果未知')
    }
    if (!nativeSessionId || nativeSessionId === binding.nativeSessionId) throw new Error('Provider 未返回新的原生分支身份')
    await verifyIdentity()
    return conversationSummary(await deps.store.finishFork(begun.conversation.id, { status: 'accepted', nativeSessionId }), active)
  } catch (error) {
    // A successful atomic publish may lose its acknowledgement. Read, never replay the native fork.
    const persisted = await deps.store.read(begun.conversation.id)
    if (persisted?.fork?.status !== 'pending') {
      if (!persisted) throw error
      return conversationSummary(persisted, active)
    }
    return conversationSummary(await deps.store.finishFork(begun.conversation.id, {
      status: attempting ? 'unknown' : 'not_sent', reason: error instanceof Error ? error.message : String(error)
    }), active)
  }
}
