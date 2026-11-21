import type { Evidence } from '../../shared/turn-record-contracts'
import {
  ORCHESTRATION_EVENT_TYPES,
  type OrchestrationEventType,
  type OrchestrationScope,
  type OrdinalOrigin,
  type PreparedBody,
  type SessionLineage,
  type TurnAuthor,
  type TurnDeliveryState,
  isAgentActor
} from './types'

export interface BaseCommand {
  commandId: string
  actor: string
  scope: OrchestrationScope
  at: number
  payloadSha256: string
  /** Optional deterministic id generator for tests/replays. */
  idPrefix?: string
}

export interface RunSubmitPayload {
  runId: string
  sessionKey: string | null
  conversationId?: string | null
  ordinal?: number
  ordinalOrigin?: OrdinalOrigin
  provider: string
  profile: string | null
  cwd: string
  promptPreview?: string
  userTextPreview?: string
  body?: PreparedBody
  claimMode: 'immediate' | 'queued'
  leaseOwner?: string
  pendingTtlMs?: number
  origin?: 'local' | 'remote' | 'system'
  isConversationRun?: boolean
  /** P4-1 shadow writes mark outbox rows done + shadowOnly so P4-2 recovery never dispatches them. */
  shadowOnly?: boolean
  /** Historical terminal backfill: never claims or clobbers a session's active live run slot. */
  historicalBackfill?: boolean
  /** Historical backfill when H3 ordinal is missing: skip `turn.began` rather than fabricating MAX+1. */
  skipTurnProjection?: boolean
  /** H1 SessionLedger `detailDigest(detail)` so DB-rebuilt H1 snapshots match exact idempotency digests. */
  intentDetailSha256?: string
  /** Single-commit immediate dispatch: atomically emit run.admitted + run.dispatched after §2.3 recheck. */
  dispatchImmediately?: boolean
}

export interface RunResolveIntentPayload {
  targetCommandId: string
  tombstoneRunId: string
}

export interface RunStopPayload {
  runId: string
  reason?: string
  shadowOnly?: boolean
}

export interface SessionStopSubtasksPayload {
  sessionKey: string
  reason?: string
  shadowOnly?: boolean
}

export type EffectResultStep =
  | 'admitted'
  | 'dispatched'
  | 'admitted_and_dispatched'
  | 'session_bound'
  | 'question_opened'
  | 'question_closed'
  | 'provider_settled'
  | 'finalized'
  | 'settled'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'content_gap'

export interface RunEffectResultPayload {
  runId: string
  step: EffectResultStep
  reason?: string
  detail?: string
  isError?: boolean
  providerResultRef?: string
  nativeSessionId?: string
  bindingId?: string
  questionId?: string
  questionKind?: string
  questionSource?: string
  outputSeq?: number
  contentRef?: string
  evidence?: string[]
  outcome?: Evidence<string>
  delivery?: Exclude<TurnDeliveryState, 'pending'>
  gapReason?: 'output_capture_failed' | 'history_capture_failed'
  settledAt?: number | null
  recoveredAt?: number | null
  /** Historical terminal backfill: preserves newer live session `last_run_id` / `last_run_outcome`. */
  historicalBackfill?: boolean
  /** Present only for test negative-control assertions; forbidden in provider_settled. */
  extra?: Record<string, unknown>
}

export interface QuestionAnswerPayload {
  runId: string
  questionId: string
  answerId: string
  answerSha256: string
  answerPayload?: Record<string, unknown>
  /** R3 explicit attribution; defaults to peer actor or `'unavailable'` when peer is unknown. */
  answeredBy?: string
  shadowOnly?: boolean
}

export interface SessionCreatePayload {
  sessionKey: string
  conversationId?: string | null
  provider?: string | null
  profile?: string | null
  cwd?: string | null
  title?: string | null
  parentSessionKey?: string | null
  rootSessionKey?: string | null
  lineage?: SessionLineage | null
}

export interface SessionRenamePayload {
  sessionKey: string
  title: string
}

export interface SessionTogglePayload {
  sessionKey: string
}

export interface SessionForkPayload {
  sessionKey: string
  conversationId?: string | null
  provider?: string | null
  profile?: string | null
  cwd?: string | null
  title?: string | null
  parentSessionKey: string
  rootSessionKey: string
  lineage: SessionLineage
}

export interface SessionDiscoverPayload {
  sessionKey: string
  provider: string
  profile?: string | null
  cwd: string
  title?: string | null
  evidence?: string[]
}

export interface SessionImportPayload {
  sessionKey: string
  conversationId?: string | null
  provider?: string | null
  profile?: string | null
  cwd?: string | null
  title?: string | null
  ts: number
  pinnedAt?: number | null
  archivedAt?: number | null
  lastRunId?: string | null
  lastRunOutcome?: Evidence<string> | null
  parentSessionKey?: string | null
  rootSessionKey?: string | null
  lineage?: SessionLineage | null
  evidence?: string[]
}

export interface HostStartPayload {
  leaseOwner: string
}

export interface TurnBeganPayload {
  sessionKey: string
  ordinal: number
  runId: string
  ordinalOrigin: OrdinalOrigin
  userTextPreview?: string | null
  author: TurnAuthor
}

export interface TurnRecordDeliveryPayload {
  sessionKey: string
  runId: string
  ordinal: number
  ordinalOrigin?: OrdinalOrigin
  delivery: Exclude<TurnDeliveryState, 'pending'>
  outcome?: Evidence<string>
  reason?: string
  evidence?: string[]
  settledAt?: number | null
}

export type OrchestrationCommand =
  | (BaseCommand & { type: 'run.submit'; payload: RunSubmitPayload })
  | (BaseCommand & { type: 'run.resolve_intent'; payload: RunResolveIntentPayload })
  | (BaseCommand & { type: 'run.stop'; payload: RunStopPayload })
  | (BaseCommand & { type: 'session.stop_subtasks'; payload: SessionStopSubtasksPayload })
  | (BaseCommand & { type: 'run.effect_result'; payload: RunEffectResultPayload })
  | (BaseCommand & { type: 'turn.record_delivery'; payload: TurnRecordDeliveryPayload })
  | (BaseCommand & { type: 'question.answer'; payload: QuestionAnswerPayload })
  | (BaseCommand & { type: 'session.create'; payload: SessionCreatePayload })
  | (BaseCommand & { type: 'session.rename'; payload: SessionRenamePayload })
  | (BaseCommand & { type: 'session.pin'; payload: SessionTogglePayload })
  | (BaseCommand & { type: 'session.unpin'; payload: SessionTogglePayload })
  | (BaseCommand & { type: 'session.archive'; payload: SessionTogglePayload })
  | (BaseCommand & { type: 'session.restore'; payload: SessionTogglePayload })
  | (BaseCommand & { type: 'session.fork'; payload: SessionForkPayload })
  | (BaseCommand & { type: 'session.discover'; payload: SessionDiscoverPayload })
  | (BaseCommand & { type: 'session.import'; payload: SessionImportPayload })
  | (BaseCommand & { type: 'host.start'; payload: HostStartPayload })

/** Pre-dispatch recheck input (core §2.3 + §2.10 R4). */
export interface PreDispatchRecheckInput {
  actor: string
  /** R4: grant check reads `principal` (equals actor for peer: commands). */
  principal: string
  cwdMatches: boolean
  workspaceAuthorized: boolean
  grantValid: boolean
  operationGateAcquired: boolean
  trustGatePassed: boolean
  /** R4 agent-only lines (never evaluated when actor is not `agent:`). */
  callerRunTerminal?: boolean
  callerRunStopRequested?: boolean
  agentCredentialRevoked?: boolean
  permissionCeilingViolated?: boolean
  projectDelegationDisabled?: boolean
  repoFingerprintMatchesUserRun?: boolean
}

export type PreDispatchRecheckResult =
  | { ok: true }
  | { ok: false; action: 'fail'; reason: string }
  | { ok: false; action: 'requeue'; reason: 'provider_authenticating' }

/**
 * Pure pre-dispatch recheck (core §2.3 + R4).
 * The 6 R4 agent rules only execute for `agent:` actors and never trigger in P4.
 */
export function evaluatePreDispatchRecheck(input: PreDispatchRecheckInput): PreDispatchRecheckResult {
  if (!input.cwdMatches) return { ok: false, action: 'fail', reason: 'cwd_changed' }
  if (!input.workspaceAuthorized) return { ok: false, action: 'fail', reason: 'workspace_not_authorized' }
  if (!input.grantValid) return { ok: false, action: 'fail', reason: 'grant_revoked' }
  if (!input.operationGateAcquired) return { ok: false, action: 'requeue', reason: 'provider_authenticating' }
  if (!input.trustGatePassed) return { ok: false, action: 'fail', reason: 'trust_gate_rejected' }

  if (isAgentActor(input.actor)) {
    if (input.callerRunTerminal) return { ok: false, action: 'fail', reason: 'caller_run_gone' }
    if (input.callerRunStopRequested) return { ok: false, action: 'fail', reason: 'caller_run_stopping' }
    if (input.agentCredentialRevoked) return { ok: false, action: 'fail', reason: 'agent_credential_revoked' }
    if (input.permissionCeilingViolated) return { ok: false, action: 'fail', reason: 'permission_ceiling_exceeded' }
    if (input.projectDelegationDisabled) return { ok: false, action: 'fail', reason: 'delegation_disabled' }
    if (input.repoFingerprintMatchesUserRun === false) {
      return { ok: false, action: 'fail', reason: 'trust_gate_rejected' }
    }
  }

  return { ok: true }
}

/**
 * R9 event decoder contract: unknown optional payload fields are ignored for forward
 * compatibility; unknown event types are rejected so clients reset to snapshot.
 */
export function decodeOrchestrationEvent(raw: unknown):
  | { ok: true; type: OrchestrationEventType; payload: Record<string, unknown> }
  | { ok: false; reason: 'invalid_shape' | 'unknown_event_type' } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'invalid_shape' }
  const candidate = raw as { type?: unknown; payload?: unknown }
  if (typeof candidate.type !== 'string' || !candidate.payload || typeof candidate.payload !== 'object' || Array.isArray(candidate.payload)) {
    return { ok: false, reason: 'invalid_shape' }
  }
  if (!ORCHESTRATION_EVENT_TYPES.has(candidate.type as OrchestrationEventType)) {
    return { ok: false, reason: 'unknown_event_type' }
  }
  return {
    ok: true,
    type: candidate.type as OrchestrationEventType,
    payload: candidate.payload as Record<string, unknown>
  }
}
