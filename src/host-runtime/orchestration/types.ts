import type { Evidence } from '../../shared/turn-record-contracts'
import type { SessionCatalogMetadata } from '../../shared/orchestration-subscribe'

export const MAX_PAYLOAD_BYTES = 16 * 1024
export const INLINE_BODY_MAX_BYTES = 16 * 1024
export const PROMPT_PREVIEW_MAX_CHARS = 200
export const USER_TEXT_PREVIEW_MAX_CHARS = 512
export const DEFAULT_PENDING_TTL_MS = 60_000

export type OrchestrationScope = 'local' | 'remote' | 'system'

/** R12: `'agent'` is reserved for P6; P4 never produces it. */
export type OrchestrationOrigin = 'local' | 'remote' | 'system' | 'agent'

/** R3: author of a turn. Daemon-dispatched turns are `'user'`; externally discovered are `'unavailable'`. */
export type TurnAuthor = 'user' | 'agent' | 'system' | 'unavailable'

/** data §3.2: turns added to imported legacy sessions count from import time. */
export type OrdinalOrigin = 'native' | 'since_import'

export type TurnDeliveryState = 'pending' | 'accepted' | 'not_sent' | 'unknown'

export type RunLifecycleState =
  | 'recorded'
  | 'admitted'
  | 'dispatched'
  | 'settled'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type H1RunLifecycle = 'recorded' | 'dispatched' | 'settled' | 'failed' | 'cancelled'

/** R1: session lineage; `'delegated'` is reserved for P6 and never emitted in P4. */
export interface SessionLineage {
  kind: 'fork' | 'side_chat' | 'delegated'
  source: {
    sessionKey: string
    runId?: string
    throughOrdinal?: number
  }
  taskId?: string
}

export type OrchestrationEventType =
  | 'run.intent_recorded'
  | 'run.admitted'
  | 'run.dispatched'
  | 'run.session_bound'
  | 'run.stop_requested'
  | 'run.question_opened'
  | 'run.question_answered'
  | 'run.question_closed'
  | 'run.provider_settled'
  | 'run.finalized'
  | 'run.transcript_referenced'
  | 'run.settled'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.interrupted'
  | 'run.content_gap'
  | 'session.created'
  | 'session.renamed'
  | 'session.pinned'
  | 'session.unpinned'
  | 'session.archived'
  | 'session.restored'
  | 'session.deleted'
  | 'session.forked'
  | 'session.discovered'
  | 'session.withdrawn'
  | 'session.imported'
  | 'turn.began'
  | 'turn.delivery'
  | 'effect.voided'
  | 'host.started'
  | 'task.requested'
  | 'task.declined'
  | 'task.child_bound'
  | 'task.settled'
  | 'task.cancel_requested'
  | 'delegation.project_policy_set'
  | 'delegation.session_full_access_set'

export const ORCHESTRATION_EVENT_TYPE_LIST: readonly OrchestrationEventType[] = [
  'run.intent_recorded',
  'run.admitted',
  'run.dispatched',
  'run.session_bound',
  'run.stop_requested',
  'run.question_opened',
  'run.question_answered',
  'run.question_closed',
  'run.provider_settled',
  'run.finalized',
  'run.transcript_referenced',
  'run.settled',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'run.content_gap',
  'session.created',
  'session.renamed',
  'session.pinned',
  'session.unpinned',
  'session.archived',
  'session.restored',
  'session.deleted',
  'session.forked',
  'session.discovered',
  'session.withdrawn',
  'session.imported',
  'turn.began',
  'turn.delivery',
  'effect.voided',
  'host.started',
  'task.requested',
  'task.declined',
  'task.child_bound',
  'task.settled',
  'task.cancel_requested',
  'delegation.project_policy_set',
  'delegation.session_full_access_set'
]

export const ORCHESTRATION_EVENT_TYPES: ReadonlySet<OrchestrationEventType> = new Set(
  ORCHESTRATION_EVENT_TYPE_LIST
)

/** R9: reserved for P6; whitelist tests assert P4 never emits or accepts them. */
export const RESERVED_TASK_EVENT_TYPES = [
  'task.requested',
  'task.child_bound',
  'task.settled',
  'task.cancel_requested'
] as const

/** R10: reserved evidence reference prefixes for P6; P4 never produces them. */
export const RESERVED_EVIDENCE_PREFIXES = ['task-result:'] as const

export function isReservedEvidenceRef(ref: string): boolean {
  return RESERVED_EVIDENCE_PREFIXES.some((prefix) => ref.startsWith(prefix))
}

export interface BodyDescriptor {
  storage: 'inline' | 'external'
  sha256: string
  bytes: number
}

export interface PreparedBody extends BodyDescriptor {
  inline?: string
}

export type OutboxState = 'pending' | 'running' | 'done' | 'failed' | 'voided'

export type CommandStatus = 'accepted' | 'rejected'

export type StickyRejectionReason =
  | 'command_payload_conflict'
  | 'illegal_transition'
  | 'invalid_target'
  | 'resolved_absent'
  | 'delegated_session_read_only'
  | 'active_subtasks_present'

export type RetryableRejectionReason =
  | 'session_run_active'
  | 'capacity_exceeded'
  | 'provider_authenticating'
  | 'device_not_authorized'
  | 'grant_revoked'
  | 'orchestration_write_indeterminate'
  | 'agent_commands_unsupported'
  | 'session_deleted_during_prepare'
  | 'caller_not_active'
  | 'delegation_disabled'
  | 'full_access_not_enabled'
  | 'limit_exceeded'
  | 'permission_mode_escalation_denied'
  | 'task_not_found'
  | 'capability_denied'
  | 'provider_unavailable'

export type TaskStatus =
  | 'awaiting_confirmation'
  | 'declined'
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_interaction'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unavailable'

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'declined',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'unavailable'
])

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status)
}

export interface TaskProjectionRow {
  taskId: string
  parentSessionKey: string
  parentRunId: string
  actor: string
  principal: string
  via: string | null
  commandId: string
  childSessionKey: string | null
  childRunId: string | null
  provider: string
  profile: string | null
  cwd: string
  status: TaskStatus
  stateVersion: number
  permissionMode: string
  permissionModeSource: 'inherited' | 'requested'
  title: string | null
  role: string | null
  targetModel: string | null
  targetEffort: string | null
  isolation: 'shared' | 'worktree'
  confirmationQuestionId: string | null
  cancelConfirmationQuestionId: string | null
  body: BodyDescriptor | null
  summary: Evidence<string> | null
  reason: string | null
  createdAt: number
  settledAt: number | null
  revSeq: number
}

export type RejectionReason = StickyRejectionReason | RetryableRejectionReason

export interface OrchestrationEventRow {
  seq: number
  eventId: string
  at: number
  type: OrchestrationEventType
  stream: string
  sessionKey: string | null
  runId: string | null
  cwd: string | null
  commandId: string | null
  actor: string
  scope: OrchestrationScope
  payload: Record<string, unknown>
  evidence: string[] | null
  /** R2: equals `actor` in P4. */
  principal: string
  /** R2: null in P4. */
  via: string | null
  /** R2: null in P4. */
  actorRunId: string | null
}

export type PendingOrchestrationEvent = Omit<OrchestrationEventRow, 'seq'>

export interface CommandReceiptRow {
  commandId: string
  actor: string
  type: string
  payloadSha256: string
  acceptedAt: number
  status: CommandStatus
  reason: string | null
  result: Record<string, unknown> | null
  resultSeq: number | null
  principal: string
  via: string | null
  actorRunId: string | null
}

export interface SessionProjectionRow {
  sessionKey: string
  conversationId: string | null
  provider: string | null
  profile: string | null
  cwd: string | null
  title: string | null
  ts: number
  pinnedAt: number | null
  archivedAt: number | null
  lastRunId: string | null
  lastRunOutcome: Evidence<string> | null
  activeRunId: string | null
  pendingQuestions: number
  legacy: boolean
  revSeq: number
  catalog: SessionCatalogMetadata | null
  /** R1 reserved columns. */
  parentSessionKey: string | null
  rootSessionKey: string | null
  lineage: SessionLineage | null
  createdBy: string | null
}

export interface TurnProjectionRow {
  sessionKey: string
  ordinal: number
  runId: string
  ordinalOrigin: OrdinalOrigin
  userTextPreview: string | null
  delivery: TurnDeliveryState
  outcome: Evidence<string> | null
  startedAt: number | null
  settledAt: number | null
  recoveredAt: number | null
  contentRef: string | null
  evidence: string[] | null
  revSeq: number
  /** R3 reserved column. */
  author: TurnAuthor
}

export interface RunProjectionRow {
  runId: string
  appRunId?: string
  sessionKey: string | null
  ownerActor: string
  scope: OrchestrationScope
  origin: OrchestrationOrigin
  provider: string | null
  profile: string | null
  cwd: string | null
  promptPreview: string | null
  lifecycle: RunLifecycleState
  stopState: string | null
  outputSeq: number | null
  intentSeq: number
  body: BodyDescriptor | null
  settledAt: number | null
  recoveredAt: number | null
  outcome: Evidence<string> | null
  revSeq: number
  /** R5 reserved column. */
  parentRunId: string | null
}

export interface InteractionProjectionRow {
  runId: string
  questionId: string
  kind: string
  source: string
  state: 'open' | 'answered' | 'closed'
  answerId: string | null
  answerSha256: string | null
  openedSeq: number
  closedSeq: number | null
  /** R3 reserved column. */
  answeredBy: string | null
}

export interface OutboxEffectRow {
  effectId: string
  kind: string
  policy: 'process_bound' | 'replayable'
  runId: string | null
  causationSeq: number
  payload: Record<string, unknown>
  state: OutboxState
  expiresAt: number | null
  attempts: number
  leaseOwner: string | null
  claimedAt: number | null
  completedAt: number | null
  resultSeq: number | null
  lastError: string | null
}

export type PendingOutboxEffect = Omit<OutboxEffectRow, 'causationSeq' | 'attempts' | 'completedAt' | 'resultSeq' | 'lastError'>

export type OrchestrationErrorCode =
  | 'orchestration_write_indeterminate'
  | 'orchestration_schema_newer'
  | 'orchestration_db_corrupt'
  | 'orchestration_network_filesystem'
  | 'orchestration_db_locked'
  | 'orchestration_payload_too_large'
  | 'orchestration_invalid_event'
  | 'orchestration_invalid_effect_kind'
  | 'orchestration_body_corrupt'
  | 'orchestration_usage_forbidden_in_event'

export class OrchestrationStoreError extends Error {
  readonly code: OrchestrationErrorCode
  constructor(code: OrchestrationErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'OrchestrationStoreError'
    this.code = code
  }
}

const PEER_ACTOR_RE = /^peer:[0-9a-f]{64}$/
const EFFECT_ACTOR_RE = /^effect:[^\s]+$/

export function isAgentActor(actor: string): boolean {
  return actor.startsWith('agent:')
}

export function isPeerActor(actor: string): boolean {
  return PEER_ACTOR_RE.test(actor)
}

export function isValidP4Actor(actor: string): boolean {
  return actor === 'system' || PEER_ACTOR_RE.test(actor) || EFFECT_ACTOR_RE.test(actor)
}
