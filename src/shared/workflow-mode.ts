/**
 * Conversation-scoped workflow recognition mode. `off` is the initial state and
 * is never written as a fabricated default: an absent field means off.
 *
 * Both `manual` and `auto` route each new human message after durable consent.
 * Manual recognizes explicit workflow intent without upgrading ordinary tasks;
 * auto keeps substantive tasks on the workflow path, including a single call.
 */
export type WorkflowConversationMode = 'off' | 'manual' | 'auto'
export type WorkflowRoutingMode = Exclude<WorkflowConversationMode, 'off'>

/** Submission-only choice; never persisted as conversation mode or sent to a Provider. */
export type WorkflowMessageOverride = 'direct' | 'workflow'

export const WORKFLOW_CONVERSATION_MODES = ['off', 'manual', 'auto'] as const

export function isWorkflowConversationMode(value: unknown): value is WorkflowConversationMode {
  return value === 'off' || value === 'manual' || value === 'auto'
}

/** Consent is a durable record of what the user agreed to, not a boolean the
 * renderer may assert. The scope text is stored so a later copy change cannot
 * silently widen what an older grant covered. */
export interface WorkflowRoutingConsent {
  grantedAt: number
  /** Bounded description of what data may leave the machine for routing. */
  scope: string
  /** Explicit acknowledgement that routing adds one Provider call per message. */
  acknowledgesExtraCall: true
}
