import type { Evidence } from '../../shared/turn-record-contracts'
import type { SessionCatalogMetadata } from '../../shared/orchestration-subscribe'
import type {
  BodyDescriptor,
  CommandReceiptRow,
  InteractionProjectionRow,
  OrchestrationOrigin,
  OrchestrationScope,
  OrdinalOrigin,
  RunLifecycleState,
  RunProjectionRow,
  SessionLineage,
  SessionProjectionRow,
  TurnAuthor,
  TurnDeliveryState,
  TurnProjectionRow
} from './types'

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  return JSON.parse(raw) as T
}

export function mapSessionRow(row: Record<string, unknown>): SessionProjectionRow {
  return {
    sessionKey: String(row.session_key),
    conversationId: (row.conversation_id as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    profile: (row.profile as string | null) ?? null,
    cwd: (row.cwd as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    ts: Number(row.ts),
    pinnedAt: row.pinned_at === null ? null : Number(row.pinned_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    lastRunId: (row.last_run_id as string | null) ?? null,
    lastRunOutcome: parseJson<Evidence<string>>(row.last_run_outcome as string | null),
    activeRunId: (row.active_run_id as string | null) ?? null,
    pendingQuestions: Number(row.pending_questions ?? 0),
    legacy: Number(row.legacy ?? 0) === 1,
    revSeq: Number(row.rev_seq),
    catalog: parseJson<SessionCatalogMetadata>(row.catalog as string | null),
    parentSessionKey: (row.parent_session_key as string | null) ?? null,
    rootSessionKey: (row.root_session_key as string | null) ?? null,
    lineage: parseJson<SessionLineage>(row.lineage as string | null),
    createdBy: (row.created_by as string | null) ?? null
  }
}

export function mapTurnRow(row: Record<string, unknown>): TurnProjectionRow {
  return {
    sessionKey: String(row.session_key),
    ordinal: Number(row.ordinal),
    runId: String(row.run_id),
    ordinalOrigin: String(row.ordinal_origin) as OrdinalOrigin,
    userTextPreview: (row.user_text_preview as string | null) ?? null,
    delivery: String(row.delivery) as TurnDeliveryState,
    outcome: parseJson<Evidence<string>>(row.outcome as string | null),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
    recoveredAt: row.recovered_at === null ? null : Number(row.recovered_at),
    contentRef: (row.content_ref as string | null) ?? null,
    evidence: parseJson<string[]>(row.evidence as string | null),
    revSeq: Number(row.rev_seq),
    author: String(row.author) as TurnAuthor
  }
}

export function mapRunRow(row: Record<string, unknown>): RunProjectionRow {
  return {
    runId: String(row.run_id),
    ...(typeof row.app_run_id === 'string' ? { appRunId: row.app_run_id } : {}),
    sessionKey: (row.session_key as string | null) ?? null,
    ownerActor: String(row.owner_actor),
    scope: String(row.scope) as OrchestrationScope,
    origin: String(row.origin) as OrchestrationOrigin,
    provider: (row.provider as string | null) ?? null,
    profile: (row.profile as string | null) ?? null,
    cwd: (row.cwd as string | null) ?? null,
    promptPreview: (row.prompt_preview as string | null) ?? null,
    lifecycle: String(row.lifecycle) as RunLifecycleState,
    stopState: (row.stop_state as string | null) ?? null,
    outputSeq: row.output_seq === null || row.output_seq === undefined ? null : Number(row.output_seq),
    intentSeq: Number(row.intent_seq),
    body: parseJson<BodyDescriptor>(row.body as string | null),
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
    recoveredAt: row.recovered_at === null ? null : Number(row.recovered_at),
    outcome: parseJson<Evidence<string>>(row.outcome as string | null),
    revSeq: Number(row.rev_seq),
    parentRunId: (row.parent_run_id as string | null) ?? null,
    ...(row.queue_position === null || row.queue_position === undefined
      ? {}
      : { queuePosition: Number(row.queue_position) }),
    ...(row.queue_held ? { queueHeld: true } : {})
  }
}

export function mapInteractionRow(row: Record<string, unknown>): InteractionProjectionRow {
  return {
    runId: String(row.run_id),
    questionId: String(row.question_id),
    kind: String(row.kind),
    source: String(row.source),
    state: String(row.state) as 'open' | 'answered' | 'closed',
    answerId: (row.answer_id as string | null) ?? null,
    answerSha256: (row.answer_sha256 as string | null) ?? null,
    openedSeq: Number(row.opened_seq),
    closedSeq: row.closed_seq === null ? null : Number(row.closed_seq),
    answeredBy: (row.answered_by as string | null) ?? null
  }
}

export function mapReceiptRow(row: Record<string, unknown>): CommandReceiptRow {
  return {
    commandId: String(row.command_id),
    actor: String(row.actor),
    type: String(row.type),
    payloadSha256: String(row.payload_sha256),
    acceptedAt: Number(row.accepted_at),
    status: String(row.status) as 'accepted' | 'rejected',
    reason: (row.reason as string | null) ?? null,
    result: parseJson<Record<string, unknown>>(row.result as string | null),
    resultSeq: row.result_seq === null ? null : Number(row.result_seq),
    principal: String(row.principal),
    via: (row.via as string | null) ?? null,
    actorRunId: (row.actor_run_id as string | null) ?? null
  }
}
