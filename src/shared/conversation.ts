import type { ProviderId } from './provider'
import type { AgentTurnRecord } from './turn-record'
import type { ContentRef } from './tool-content'

/** Explicit App archive location; not inferred from a Provider's native identity. */
export interface ConversationArchiveRef {
  sessionId: string
  providerTurnId?: string
}

/** A Scry conversation is not a Provider's native session or a transport process. */
export interface ConversationTarget {
  providerId: ProviderId
  agentProfileId?: string
  /** Main/adapter-owned compatibility identity; never inferred from the display name. */
  continuationKey: string
}

export interface ConversationBinding extends ConversationTarget {
  id: string
  nativeSessionId?: string
  /** Explicitly retired generations remain in history but can never be selected for resume. */
  retiredReason?: string
}

/** References immutable, visible historical content, not reasoning or tool protocol state. */
export interface ConversationItemRef {
  runId: string
  itemId: string
  contentHash: string
}

export type ConversationDelivery =
  | { status: 'pending' }
  | { status: 'unknown'; reason: string }
  | { status: 'not_sent'; reason: string }
  | {
      status: 'accepted'
      nativeSessionId: string
      outcome: AgentTurnRecord['status']
      /** Proven native delivery/output, not a guarantee of retention after native compaction. */
      nativeItems: ConversationItemRef[]
    }

interface ConversationTurnBase {
  ordinal: number
  runId: string
  bindingId: string
  /** Canonical content references; the archive remains the authority for bodies and usage. */
  items: ConversationItemRef[]
  /** May be unavailable after an archive failure; such bodies cannot be handed off. */
  archive?: ConversationArchiveRef
}

export interface ImportedConversationTurn extends ConversationTurnBase {
  origin: 'imported'
  /** Verified native coverage, not an assumption that every Scry event reached the model. */
  nativeItems: ConversationItemRef[]
}

export interface DispatchedConversationTurn extends ConversationTurnBase {
  origin: 'dispatch'
  commandId: string
  intentHash: string
  resumeSessionId: string | null
  /** Exact selection, not a high-watermark pretending that omitted items were delivered. */
  importedItems: ConversationItemRef[]
  omittedItems: ConversationItemRef[]
  /** Immutable body published before this intent; required for non-empty importedItems. */
  history?: ContentRef
  delivery: ConversationDelivery
}

export type ConversationTurn = ImportedConversationTurn | DispatchedConversationTurn

export interface Conversation {
  version: 1
  id: string
  cwd: string
  revision: number
  title?: string
  pinnedAt?: number
  archivedAt?: number
  /** Fingerprint of the explicitly confirmed legacy capture; original binding stays retired. */
  adoptionFingerprint?: string
  bindings: ConversationBinding[]
  turns: ConversationTurn[]
}

export type ConversationContinuation =
  | { kind: 'blocked'; runId: string; reason: string }
  | { kind: 'fresh'; missingItems: ConversationItemRef[] }
  | { kind: 'resume'; bindingId: string; nativeSessionId: string; missingItems: ConversationItemRef[] }

export const conversationItemKey = (item: ConversationItemRef): string =>
  JSON.stringify([item.runId, item.itemId, item.contentHash])

export function sameConversationTarget(a: ConversationTarget, b: ConversationTarget): boolean {
  return a.providerId === b.providerId && a.agentProfileId === b.agentProfileId &&
    a.continuationKey === b.continuationKey
}

/** Planning never resumes a foreign Provider/profile or treats an unknown delivery as unsent. */
export function planConversationContinuation(
  conversation: Conversation,
  target: ConversationTarget
): ConversationContinuation {
  const unsettled = conversation.turns.find((turn) => turn.origin === 'dispatch' &&
    (turn.delivery.status === 'pending' || turn.delivery.status === 'unknown'))
  if (unsettled) return {
    kind: 'blocked', runId: unsettled.runId,
    reason: '当前对话存在未收敛的投递；先核查原尝试，不能自动重发或切换执行'
  }
  const binding = [...conversation.bindings].reverse().find((candidate) =>
    candidate.nativeSessionId !== undefined && candidate.retiredReason === undefined &&
    sameConversationTarget(candidate, target))
  const covered = new Set<string>()
  for (const turn of conversation.turns) {
    if (!binding || turn.bindingId !== binding.id) continue
    if (turn.origin === 'imported') {
      for (const item of turn.nativeItems) covered.add(conversationItemKey(item))
    } else if (turn.delivery.status === 'accepted') {
      for (const item of [...turn.importedItems, ...turn.delivery.nativeItems]) {
        covered.add(conversationItemKey(item))
      }
    }
  }
  const missingItems = conversation.turns.flatMap((turn) => turn.items)
    .filter((item) => !covered.has(conversationItemKey(item)))
  return binding?.nativeSessionId !== undefined
    ? { kind: 'resume', bindingId: binding.id, nativeSessionId: binding.nativeSessionId, missingItems }
    : { kind: 'fresh', missingItems }
}
