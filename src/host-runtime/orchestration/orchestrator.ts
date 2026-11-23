import { truncatePreview } from './canonical-json'
import {
  decodeOrchestrationEvent,
  evaluatePreDispatchRecheck,
  type OrchestrationCommand
} from './orchestrator-commands'
import {
  acceptDecision,
  decideCatalogChange,
  decideRunEffectResult,
  makeEffect,
  makeEvent,
  retryableReject,
  stickyReject,
  type DecisionResult,
  type OrchestratorReadView
} from './orchestrator-handlers'
import {
  appendL4ParentEndVoidEvents,
  decideRunStop,
  decideSessionStopSubtasks,
  decideTaskOrPolicyCommand
} from './orchestrator-task-handlers'
import {
  DEFAULT_PENDING_TTL_MS,
  PROMPT_PREVIEW_MAX_CHARS,
  USER_TEXT_PREVIEW_MAX_CHARS,
  isAgentActor,
  isPeerActor,
  isValidP4Actor,
  type PendingOrchestrationEvent,
  type RejectionReason,
  type RetryableRejectionReason,
  type StickyRejectionReason
} from './types'

export { decodeOrchestrationEvent, evaluatePreDispatchRecheck }
export type { DecisionResult, OrchestratorReadView } from './orchestrator-handlers'
export type { OrchestrationCommand } from './orchestrator-commands'

const STICKY_REASONS: ReadonlySet<StickyRejectionReason> = new Set([
  'command_payload_conflict',
  'illegal_transition',
  'invalid_target',
  'resolved_absent',
  'delegated_session_read_only',
  'active_subtasks_present'
])

const RETRYABLE_REASONS: ReadonlySet<RetryableRejectionReason> = new Set([
  'session_run_active',
  'capacity_exceeded',
  'provider_authenticating',
  'device_not_authorized',
  'grant_revoked',
  'orchestration_write_indeterminate',
  'agent_commands_unsupported',
  'session_deleted_during_prepare',
  'caller_not_active',
  'delegation_disabled',
  'full_access_not_enabled',
  'limit_exceeded',
  'permission_mode_escalation_denied',
  'task_not_found',
  'capability_denied',
  'provider_unavailable'
])

export function isStickyRejection(reason: RejectionReason): reason is StickyRejectionReason {
  return STICKY_REASONS.has(reason as StickyRejectionReason)
}

export function isRetryableRejection(reason: RejectionReason): reason is RetryableRejectionReason {
  return RETRYABLE_REASONS.has(reason as RetryableRejectionReason)
}

const AGENT_ALLOWED_COMMANDS = new Set<OrchestrationCommand['type']>([
  'task.request',
  'task.cancel_request'
])

const PEER_ONLY_COMMANDS = new Set<OrchestrationCommand['type']>([
  'delegation.set_project_policy',
  'delegation.set_session_full_access',
  'task.confirm',
  'task.confirm_cancel',
  'session.stop_subtasks'
])

/**
 * Pure synchronous orchestrator decision function (core §2.1).
 * Performs zero I/O; reads only `view` and returns events, effects, and receipt.
 */
export function decide(cmd: OrchestrationCommand, view: OrchestratorReadView): DecisionResult {
  if (isAgentActor(cmd.actor)) {
    if (PEER_ONLY_COMMANDS.has(cmd.type) || cmd.type === 'question.answer') {
      return retryableReject('device_not_authorized')
    }
    if (!AGENT_ALLOWED_COMMANDS.has(cmd.type)) {
      return retryableReject('agent_commands_unsupported')
    }
    if (!cmd.principal || !isPeerActor(cmd.principal) || !view.isActorAuthorized(cmd.principal)) {
      return retryableReject('device_not_authorized')
    }
  } else if (!isValidP4Actor(cmd.actor) || !view.isActorAuthorized(cmd.actor)) {
    return retryableReject('device_not_authorized')
  }

  if (cmd.type !== 'run.resolve_intent') {
    const existing = view.getReceipt(cmd.commandId, cmd.actor)
    if (existing) {
      if (existing.payloadSha256 === cmd.payloadSha256) return { kind: 'duplicate', receipt: existing }
      return stickyReject(cmd, 'command_payload_conflict', { writeReceipt: false })
    }
  }

  switch (cmd.type) {
    case 'run.submit': {
      const p = cmd.payload
      if (p.sessionKey && isPeerActor(cmd.actor)) {
        const targetSession = view.getSession(p.sessionKey)
        if (targetSession?.lineage?.kind === 'delegated') {
          return stickyReject(cmd, 'delegated_session_read_only', { writeReceipt: true })
        }
      }
      if (p.sessionKey && !p.historicalBackfill && view.hasActiveRunForSession(p.sessionKey)) {
        return retryableReject('session_run_active')
      }
      if (!p.historicalBackfill && view.activeRunCount() >= view.maxActiveRuns()) {
        return retryableReject('capacity_exceeded')
      }
      if (!p.historicalBackfill && view.isProviderAuthenticating(p.provider, p.profile)) {
        return retryableReject('provider_authenticating')
      }
      if (view.getRun(p.runId)) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })

      const promptPreview = truncatePreview(p.promptPreview, PROMPT_PREVIEW_MAX_CHARS)
      const bodyDescriptor = p.body ? { storage: p.body.storage, sha256: p.body.sha256, bytes: p.body.bytes } : null
      const events: PendingOrchestrationEvent[] = [
        makeEvent(cmd, 0, {
          type: 'run.intent_recorded',
          stream: `run:${p.runId}`,
          sessionKey: p.sessionKey,
          runId: p.runId,
          cwd: p.cwd,
          payload: {
            runId: p.runId,
            sessionKey: p.sessionKey,
            provider: p.provider,
            profile: p.profile,
            cwd: p.cwd,
            origin: p.origin ?? (cmd.scope === 'local' ? 'local' : cmd.scope === 'remote' ? 'remote' : 'system'),
            ...(promptPreview !== null ? { promptPreview } : {}),
            ...(p.intentDetailSha256 ? { intentDetailSha256: p.intentDetailSha256 } : {}),
            ...(bodyDescriptor ? { body: bodyDescriptor } : {}),
            ...(p.isConversationRun ? { isConversationRun: true } : {}),
            ...(p.historicalBackfill ? { historicalBackfill: true } : {})
          }
        })
      ]
      if (p.sessionKey && !p.skipTurnProjection) {
        const ordinal = p.ordinal ?? view.getNextTurnOrdinal?.(p.sessionKey) ?? 1
        const ordinalOrigin =
          p.ordinalOrigin ?? (view.getSession(p.sessionKey)?.legacy ? 'since_import' : 'native')
        events.push(
          makeEvent(cmd, 1, {
            type: 'turn.began',
            stream: `session:${p.sessionKey}`,
            sessionKey: p.sessionKey,
            runId: p.runId,
            cwd: p.cwd,
            payload: {
              sessionKey: p.sessionKey,
              runId: p.runId,
              ordinal,
              ordinalOrigin,
              userTextPreview: truncatePreview(p.userTextPreview ?? p.promptPreview, USER_TEXT_PREVIEW_MAX_CHARS),
              author: 'user'
            }
          })
        )
      }
      const effectPayload: Record<string, unknown> = {
        runId: p.runId,
        sessionKey: p.sessionKey,
        provider: p.provider,
        profile: p.profile,
        cwd: p.cwd,
        ...(p.shadowOnly ? { shadowOnly: true } : {}),
        ...(p.body
          ? p.body.storage === 'inline'
            ? { body: { storage: 'inline', sha256: p.body.sha256, bytes: p.body.bytes, inline: p.body.inline } }
            : { body: { storage: 'external', sha256: p.body.sha256, bytes: p.body.bytes } }
          : {})
      }
      const isImmediate = p.claimMode === 'immediate'
      if (p.dispatchImmediately && isImmediate && !p.shadowOnly && !p.historicalBackfill) {
        const dispatchFields = { stream: `run:${p.runId}`, sessionKey: p.sessionKey, runId: p.runId, cwd: p.cwd, payload: { runId: p.runId } }
        events.push(makeEvent(cmd, events.length, { ...dispatchFields, type: 'run.admitted' }))
        events.push(makeEvent(cmd, events.length, { ...dispatchFields, type: 'run.dispatched' }))
      }
      const boundedPendingTtlMs = Math.min(Math.max(1, p.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS), DEFAULT_PENDING_TTL_MS)
      const effect = makeEffect(cmd, 0, {
        kind: 'provider.run.start',
        runId: p.runId,
        payload: effectPayload,
        state: p.shadowOnly ? 'done' : isImmediate ? 'running' : 'pending',
        expiresAt: p.shadowOnly || isImmediate ? null : cmd.at + boundedPendingTtlMs,
        leaseOwner: p.shadowOnly ? 'shadow:no-dispatch' : isImmediate ? (p.leaseOwner ?? 'daemon') : null,
        claimedAt: p.shadowOnly || isImmediate ? cmd.at : null
      })
      return acceptDecision(cmd, events, [effect], {
        runId: p.runId,
        ...(cmd.actor === 'system' && p.intentDetailSha256 ? { intentDetailSha256: p.intentDetailSha256 } : {})
      })
    }

    case 'run.resolve_intent': {
      const existing = view.getReceipt(cmd.payload.targetCommandId, cmd.actor)
      if (existing) return { kind: 'duplicate', receipt: existing }
      const tombstoneResult = { runId: cmd.payload.tombstoneRunId, state: 'cancelled' }
      return stickyReject(cmd, 'resolved_absent', {
        writeReceipt: true,
        overrideReceipt: {
          commandId: cmd.payload.targetCommandId,
          actor: cmd.actor,
          type: 'run.submit',
          payloadSha256: 'resolved_absent',
          result: tombstoneResult
        },
        result: tombstoneResult
      })
    }

    case 'run.stop':
      return decideRunStop(cmd, view)

    case 'session.stop_subtasks':
      return decideSessionStopSubtasks(cmd, view)

    case 'run.effect_result': {
      const result = decideRunEffectResult(cmd, view)
      if (result.kind === 'accepted' && ['settled', 'failed', 'cancelled', 'interrupted'].includes(cmd.payload.step)) {
        const parentRun = view.getRun(cmd.payload.runId)
        if (parentRun) appendL4ParentEndVoidEvents(cmd, parentRun, view, result.events)
      }
      return result
    }

    case 'turn.record_delivery': {
      const p = cmd.payload
      const events: PendingOrchestrationEvent[] = []
      const existingTurn = view.getTurnByRunId?.(p.runId)
      const session = view.getSession(p.sessionKey)
      if (!existingTurn) {
        events.push(
          makeEvent(cmd, events.length, {
            type: 'turn.began',
            stream: `session:${p.sessionKey}`,
            sessionKey: p.sessionKey,
            runId: p.runId,
            cwd: session?.cwd ?? null,
            payload: {
              sessionKey: p.sessionKey,
              runId: p.runId,
              ordinal: p.ordinal,
              ordinalOrigin: p.ordinalOrigin ?? (session?.legacy ? 'since_import' : 'native'),
              userTextPreview: null,
              author: 'user'
            }
          })
        )
      }
      events.push(
        makeEvent(cmd, events.length, {
          type: 'turn.delivery',
          stream: `session:${p.sessionKey}`,
          sessionKey: p.sessionKey,
          runId: p.runId,
          cwd: session?.cwd ?? null,
          payload: {
            runId: p.runId,
            delivery: p.delivery,
            ...(p.reason ? { reason: p.reason } : {}),
            ...(p.outcome ? { outcome: p.outcome } : {}),
            ...(p.settledAt !== undefined ? { settledAt: p.settledAt } : {})
          },
          evidence: p.evidence ?? null
        })
      )
      return acceptDecision(cmd, events, [], { sessionKey: p.sessionKey, runId: p.runId, delivery: p.delivery })
    }

    case 'question.answer': {
      const p = cmd.payload
      const interaction = view.getInteraction(p.runId, p.questionId)
      if (!interaction) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
      if (interaction.state !== 'open') return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
      const run = view.getRun(p.runId)
      const events = [
        makeEvent(cmd, 0, {
          type: 'run.question_answered',
          stream: `run:${p.runId}`,
          sessionKey: run?.sessionKey ?? null,
          runId: p.runId,
          cwd: run?.cwd ?? null,
          payload: {
            runId: p.runId,
            questionId: p.questionId,
            answerId: p.answerId,
            answerSha256: p.answerSha256,
            answeredBy: p.answeredBy ?? (isPeerActor(cmd.actor) ? cmd.actor : 'unavailable')
          }
        })
      ]
      const effects = [
        makeEffect(cmd, 0, {
          kind: 'question.respond',
          runId: p.runId,
          payload: {
            runId: p.runId,
            questionId: p.questionId,
            answerId: p.answerId,
            ...(p.shadowOnly ? { shadowOnly: true } : {}),
            ...(p.answerPayload ? { answerPayload: p.answerPayload } : {})
          },
          state: p.shadowOnly ? 'done' : 'pending',
          leaseOwner: p.shadowOnly ? 'shadow:no-dispatch' : null,
          claimedAt: p.shadowOnly ? cmd.at : null
        })
      ]
      return acceptDecision(cmd, events, effects, { runId: p.runId, questionId: p.questionId })
    }

    case 'session.create': {
      const p = cmd.payload
      if (p.lineage?.kind === 'delegated') return retryableReject('agent_commands_unsupported')
      const event = makeEvent(cmd, 0, {
        type: 'session.created',
        stream: `session:${p.sessionKey}`,
        sessionKey: p.sessionKey,
        cwd: p.cwd ?? null,
        payload: {
          sessionKey: p.sessionKey,
          conversationId: p.conversationId ?? null,
          provider: p.provider ?? null,
          profile: p.profile ?? null,
          cwd: p.cwd ?? null,
          title: p.title ?? null,
          parentSessionKey: p.parentSessionKey ?? null,
          rootSessionKey: p.rootSessionKey ?? null,
          lineage: p.lineage ?? null,
          createdBy: cmd.actor
        }
      })
      return acceptDecision(cmd, [event], [], { sessionKey: p.sessionKey })
    }

    case 'session.fork': {
      const p = cmd.payload
      if (p.lineage.kind !== 'fork') return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
      const event = makeEvent(cmd, 0, {
        type: 'session.forked',
        stream: `session:${p.sessionKey}`,
        sessionKey: p.sessionKey,
        cwd: p.cwd ?? null,
        payload: {
          sessionKey: p.sessionKey,
          conversationId: p.conversationId ?? null,
          provider: p.provider ?? null,
          profile: p.profile ?? null,
          cwd: p.cwd ?? null,
          title: p.title ?? null,
          parentSessionKey: p.parentSessionKey,
          rootSessionKey: p.rootSessionKey,
          lineage: p.lineage,
          createdBy: cmd.actor
        }
      })
      return acceptDecision(cmd, [event], [], { sessionKey: p.sessionKey })
    }

    case 'session.rename': {
      const existing = view.getSession(cmd.payload.sessionKey)
      if (!existing) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
      const event = makeEvent(cmd, 0, {
        type: 'session.renamed',
        stream: `session:${existing.sessionKey}`,
        sessionKey: existing.sessionKey,
        cwd: existing.cwd,
        payload: { sessionKey: existing.sessionKey, title: cmd.payload.title }
      })
      return acceptDecision(cmd, [event], [], { sessionKey: existing.sessionKey })
    }

    case 'session.pin':
    case 'session.unpin':
    case 'session.archive':
    case 'session.restore': {
      const existing = view.getSession(cmd.payload.sessionKey)
      if (!existing) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
      if (cmd.type === 'session.archive' && (view.countNonTerminalTasksBySession?.(existing.sessionKey) ?? 0) > 0) {
        return stickyReject(cmd, 'active_subtasks_present', { writeReceipt: true })
      }
      const typeMap = {
        'session.pin': 'session.pinned',
        'session.unpin': 'session.unpinned',
        'session.archive': 'session.archived',
        'session.restore': 'session.restored'
      } as const
      const event = makeEvent(cmd, 0, {
        type: typeMap[cmd.type],
        stream: `session:${existing.sessionKey}`,
        sessionKey: existing.sessionKey,
        cwd: existing.cwd,
        payload: { sessionKey: existing.sessionKey }
      })
      return acceptDecision(cmd, [event], [], { sessionKey: existing.sessionKey })
    }

    case 'session.discover':
    case 'session.withdraw':
      return decideCatalogChange(cmd, view)

    case 'session.import': {
      const p = cmd.payload
      const sanitizedOutcome = p.lastRunOutcome
        ? {
            ...p.lastRunOutcome,
            quality: p.lastRunOutcome.quality === 'exact' ? 'inferred' : p.lastRunOutcome.quality
          }
        : null
      const event = makeEvent(cmd, 0, {
        type: 'session.imported',
        stream: `session:${p.sessionKey}`,
        sessionKey: p.sessionKey,
        cwd: p.cwd ?? null,
        payload: {
          sessionKey: p.sessionKey,
          conversationId: p.conversationId ?? null,
          provider: p.provider ?? null,
          profile: p.profile ?? null,
          cwd: p.cwd ?? null,
          title: p.title ?? null,
          ts: p.ts,
          pinnedAt: p.pinnedAt ?? null,
          archivedAt: p.archivedAt ?? null,
          lastRunId: p.lastRunId ?? null,
          lastRunOutcome: sanitizedOutcome,
          ...(p.catalog ? { catalog: p.catalog } : {}),
          parentSessionKey: p.parentSessionKey ?? null,
          rootSessionKey: p.rootSessionKey ?? null,
          lineage: p.lineage ?? null
        },
        evidence: p.evidence ?? null
      })
      return acceptDecision(cmd, [event], [], { sessionKey: p.sessionKey })
    }

    case 'host.start': {
      const event = makeEvent(cmd, 0, {
        type: 'host.started',
        stream: 'host',
        payload: { leaseOwner: cmd.payload.leaseOwner }
      })
      return acceptDecision(cmd, [event], [], { leaseOwner: cmd.payload.leaseOwner })
    }

    case 'delegation.set_project_policy':
    case 'delegation.set_session_full_access':
    case 'task.request':
    case 'task.cancel_request':
    case 'task.confirm':
    case 'task.confirm_cancel':
    case 'task.settle':
      return decideTaskOrPolicyCommand(cmd, view)
  }
}
