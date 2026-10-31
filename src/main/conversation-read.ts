import type { ConversationPage } from '../shared/conversation-api'
import type { LoadedSessionTurn } from '../shared/session-history'
import type { ConversationServiceDeps } from './conversation-service-deps'
import type { Conversation } from '../shared/conversation'
import { conversationSummary } from './conversation-summary'
import { sideChatPage } from './conversation-side-chat'

/** One visible history page; 40 turns is the renderer's page size, not a read bound. */
export const CONVERSATION_PAGE_TURNS = 40

type ConversationTurn = Conversation['turns'][number]

/**
 * Read exactly one page and resolve each selected turn's archived history once.
 *
 * Turn projection is batched per binding/archive so a page never rereads one native
 * session per turn. `loadTurns` answers only the turns it could project: a turn with
 * no history entry stays explicitly unavailable instead of being shown as empty.
 */
export async function readConversationPage(
  deps: Pick<ConversationServiceDeps, 'store' | 'loadTurns'>,
  active: ReadonlySet<string>,
  id: string,
  beforeOrdinal?: number
): Promise<ConversationPage> {
  const conversation = await deps.store.read(id)
  if (!conversation) throw new Error('找不到对话，不会自动创建空历史')
  const frozen = sideChatPage(conversation)
  if (conversation.deletion) {
    return { summary: conversationSummary(conversation, active), bindings: structuredClone(conversation.bindings), turns: [] }
  }
  const end = beforeOrdinal === undefined
    ? conversation.turns.length
    : Math.max(0, Math.min(beforeOrdinal, conversation.turns.length))
  const start = Math.max(0, end - CONVERSATION_PAGE_TURNS)
  const selected = conversation.turns.slice(start, end)
  const history = await loadPageHistory(deps, conversation, selected)
  const turns = selected.map((turn: ConversationTurn) => {
    const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)!
    const loaded = history.get(turn.runId)
    return {
      ordinal: turn.ordinal,
      runId: turn.runId,
      bindingId: turn.bindingId,
      providerId: binding.providerId,
      ...(turn.origin === 'dispatch' ? { commandId: turn.commandId } : {}),
      delivery: turn.origin === 'imported' ? { status: 'imported' as const } : turn.delivery,
      ...(loaded ? { history: loaded } : {}),
      ...(!loaded ? { unavailableReason: '历史正文需从其权威归档读取' } : {})
    }
  })
  return {
    summary: conversationSummary(conversation, active),
    bindings: structuredClone(conversation.bindings),
    turns,
    ...(frozen ? { sideChat: frozen } : {}),
    ...(start > 0 ? { nextBeforeOrdinal: start } : {})
  }
}

/** Imported prefix turns have no archive of their own; only archived turns can project. */
async function loadPageHistory(
  deps: Pick<ConversationServiceDeps, 'loadTurns'>,
  conversation: Conversation,
  selected: readonly ConversationTurn[]
): Promise<ReadonlyMap<string, LoadedSessionTurn>> {
  if (!deps.loadTurns) return new Map()
  const archived = selected.filter((turn) => turn.archive)
  if (archived.length === 0) return new Map()
  return deps.loadTurns(conversation, archived)
}
