import { truncatePreview } from './canonical-json'
import { DEFAULT_DELEGATION_LIMITS } from './delegation-limits'
import type { OrchestrationCommand } from './orchestrator-commands'
import {
  acceptDecision,
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
  decideTaskConfirm,
  isCallerRunActive
} from './orchestrator-task-lifecycle'
import { isTerminalRunLifecycle } from './run-transitions'
import {
  PROMPT_PREVIEW_MAX_CHARS,
  isAgentActor,
  isPeerActor,
  isTerminalTaskStatus,
  type PendingOrchestrationEvent,
  type PendingOutboxEffect
} from './types'

export { appendL4ParentEndVoidEvents, decideRunStop, decideSessionStopSubtasks }

export type TaskOrPolicyCommand = Extract<
  OrchestrationCommand,
  | { type: 'delegation.set_project_policy' }
  | { type: 'delegation.set_session_full_access' }
  | { type: 'task.request' }
  | { type: 'task.cancel_request' }
  | { type: 'task.confirm' }
  | { type: 'task.confirm_cancel' }
  | { type: 'task.settle' }
>

export function decideTaskOrPolicyCommand(
  cmd: TaskOrPolicyCommand,
  view: OrchestratorReadView
): DecisionResult {
  switch (cmd.type) {
    case 'delegation.set_project_policy': {
      if (!isPeerActor(cmd.actor) || cmd.scope !== 'local') {
        return retryableReject('device_not_authorized')
      }
      const p = cmd.payload
      const event = makeEvent(cmd, 0, {
        type: 'delegation.project_policy_set',
        stream: `policy:project:${p.cwd}`,
        cwd: p.cwd,
        payload: { cwd: p.cwd, enabled: p.enabled }
      })
      return acceptDecision(cmd, [event], [], { cwd: p.cwd, enabled: p.enabled })
    }

    case 'delegation.set_session_full_access': {
      if (!isPeerActor(cmd.actor) || cmd.scope !== 'local') {
        return retryableReject('device_not_authorized')
      }
      const p = cmd.payload
      const event = makeEvent(cmd, 0, {
        type: 'delegation.session_full_access_set',
        stream: `session:${p.sessionKey}`,
        sessionKey: p.sessionKey,
        payload: { sessionKey: p.sessionKey, enabled: p.enabled }
      })
      return acceptDecision(cmd, [event], [], { sessionKey: p.sessionKey, enabled: p.enabled })
    }

    case 'task.request': {
      if (!isAgentActor(cmd.actor)) return retryableReject('device_not_authorized')
      const p = cmd.payload
      const parentRun = view.getRun(p.parentRunId)
      if (!isCallerRunActive(parentRun)) return retryableReject('caller_not_active')
      if (!view.isProjectDelegationEnabled?.(p.cwd)) return retryableReject('delegation_disabled')
      if (p.permissionMode === 'full_access' && !view.isSessionFullAccessEnabled?.(p.parentSessionKey)) {
        return retryableReject('full_access_not_enabled')
      }
      if (view.getTask?.(p.taskId)) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })

      const limits = view.delegationLimits?.() ?? DEFAULT_DELEGATION_LIMITS
      const concurrent = view.countNonTerminalTasksByParentRun?.(p.parentRunId) ?? 0
      const total = view.countTotalTasksByParentRun?.(p.parentRunId) ?? 0
      const hostAgentRuns = view.countNonTerminalAgentRuns?.() ?? 0
      if (concurrent >= limits.maxConcurrentPerParentRun) return retryableReject('limit_exceeded')
      if (total >= limits.maxTotalPerParentRun) return stickyReject(cmd, 'limit_exceeded', { writeReceipt: true })
      if (hostAgentRuns >= limits.maxHostAgentRuns) return retryableReject('limit_exceeded')

      const bodyDescriptor = p.body
        ? p.body.storage === 'inline'
          ? { storage: 'inline' as const, sha256: p.body.sha256, bytes: p.body.bytes, inline: p.body.inline }
          : { storage: 'external' as const, sha256: p.body.sha256, bytes: p.body.bytes }
        : null
      const promptPreview = truncatePreview(p.promptPreview, PROMPT_PREVIEW_MAX_CHARS)
      const events: PendingOrchestrationEvent[] = [
        makeEvent(cmd, 0, {
          type: 'task.requested',
          stream: `session:${p.parentSessionKey}`,
          sessionKey: p.parentSessionKey,
          runId: p.parentRunId,
          cwd: p.cwd,
          payload: {
            taskId: p.taskId,
            parentSessionKey: p.parentSessionKey,
            parentRunId: p.parentRunId,
            provider: p.provider,
            profile: p.profile,
            cwd: p.cwd,
            title: p.title ?? null,
            role: p.role ?? null,
            targetModel: p.targetModel ?? null,
            targetEffort: p.targetEffort ?? null,
            permissionMode: p.permissionMode,
            permissionModeSource: p.permissionModeSource,
            isolation: p.isolation ?? 'shared',
            confirmationQuestionId: p.confirmationQuestionId,
            ...(bodyDescriptor ? { body: bodyDescriptor } : {}),
            ...(promptPreview !== null ? { promptPreview } : {})
          }
        }),
        makeEvent(cmd, 1, {
          type: 'run.question_opened',
          stream: `run:${p.parentRunId}`,
          sessionKey: p.parentSessionKey,
          runId: p.parentRunId,
          cwd: p.cwd,
          payload: {
            runId: p.parentRunId,
            questionId: p.confirmationQuestionId,
            kind: 'delegation_confirmation',
            source: 'scry_orchestrator',
            taskId: p.taskId
          }
        })
      ]
      return acceptDecision(cmd, events, [], {
        taskId: p.taskId,
        status: 'awaiting_confirmation',
        stateVersion: 1,
        confirmationQuestionId: p.confirmationQuestionId
      })
    }

    case 'task.cancel_request': {
      if (!isAgentActor(cmd.actor)) return retryableReject('device_not_authorized')
      const p = cmd.payload
      const task = view.getTask?.(p.taskId)
      if (!task || task.parentSessionKey !== p.parentSessionKey) return retryableReject('task_not_found')
      if (isTerminalTaskStatus(task.status)) {
        return acceptDecision(cmd, [], [], { taskId: task.taskId, status: task.status, alreadyTerminal: true })
      }
      const callerRunId = cmd.actorRunId ?? task.parentRunId
      const callerRun = view.getRun(callerRunId)
      if (!isCallerRunActive(callerRun) || callerRun?.sessionKey !== p.parentSessionKey) {
        return retryableReject('caller_not_active')
      }
      const events: PendingOrchestrationEvent[] = [
        makeEvent(cmd, 0, {
          type: 'task.cancel_requested',
          stream: `session:${task.parentSessionKey}`,
          sessionKey: task.parentSessionKey,
          runId: callerRunId,
          cwd: task.cwd,
          payload: {
            taskId: task.taskId,
            reason: p.reason ?? null,
            confirmationQuestionId: p.confirmationQuestionId,
            questionRunId: callerRunId
          }
        }),
        makeEvent(cmd, 1, {
          type: 'run.question_opened',
          stream: `run:${callerRunId}`,
          sessionKey: task.parentSessionKey,
          runId: callerRunId,
          cwd: task.cwd,
          payload: {
            runId: callerRunId,
            questionId: p.confirmationQuestionId,
            kind: 'delegation_cancel_confirmation',
            source: 'scry_orchestrator',
            taskId: task.taskId
          }
        })
      ]
      return acceptDecision(cmd, events, [], {
        taskId: task.taskId,
        status: task.status,
        confirmationQuestionId: p.confirmationQuestionId,
        questionRunId: callerRunId
      })
    }

    case 'task.confirm':
      return decideTaskConfirm(cmd, view)

    case 'task.confirm_cancel': {
      if (!isPeerActor(cmd.actor) || cmd.scope !== 'local') return retryableReject('device_not_authorized')
      const p = cmd.payload
      const task = view.getTask?.(p.taskId)
      if (!task) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
      if (!task.cancelConfirmationQuestionId || task.cancelConfirmationQuestionId !== p.questionId) {
        return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
      }
      const questionRunId = p.questionRunId ?? task.parentRunId
      const interaction = view.getInteraction(questionRunId, p.questionId)
      if (!interaction || interaction.state !== 'open' || interaction.kind !== 'delegation_cancel_confirmation') {
        return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
      }

      const events: PendingOrchestrationEvent[] = [
        makeEvent(cmd, 0, {
          type: 'run.question_answered',
          stream: `run:${questionRunId}`,
          sessionKey: task.parentSessionKey,
          runId: questionRunId,
          cwd: task.cwd,
          payload: {
            runId: questionRunId,
            questionId: p.questionId,
            answerId: p.answerId,
            answerSha256: p.answerSha256,
            answeredBy: cmd.actor
          }
        }),
        makeEvent(cmd, 1, {
          type: 'run.question_closed',
          stream: `run:${questionRunId}`,
          sessionKey: task.parentSessionKey,
          runId: questionRunId,
          cwd: task.cwd,
          payload: {
            runId: questionRunId,
            questionId: p.questionId,
            reason: p.approved ? 'approved' : 'declined'
          }
        })
      ]
      const effects: PendingOutboxEffect[] = []
      if (p.approved && !isTerminalTaskStatus(task.status)) {
        if (task.status === 'awaiting_confirmation') {
          if (task.confirmationQuestionId && view.getInteraction(task.parentRunId, task.confirmationQuestionId)?.state === 'open') {
            events.push(
              makeEvent(cmd, events.length, {
                type: 'run.question_closed',
                stream: `run:${task.parentRunId}`,
                sessionKey: task.parentSessionKey,
                runId: task.parentRunId,
                cwd: task.cwd,
                payload: { runId: task.parentRunId, questionId: task.confirmationQuestionId, reason: 'cancelled' }
              })
            )
          }
          events.push(
            makeEvent(cmd, events.length, {
              type: 'task.settled',
              stream: `session:${task.parentSessionKey}`,
              sessionKey: task.parentSessionKey,
              runId: task.parentRunId,
              cwd: task.cwd,
              payload: { taskId: task.taskId, status: 'cancelled', reason: p.reason ?? 'cancel_confirmed' }
            })
          )
        } else if (task.childRunId) {
          const childRun = view.getRun(task.childRunId)
          if (childRun && !isTerminalRunLifecycle(childRun.lifecycle)) {
            events.push(
              makeEvent(cmd, events.length, {
                type: 'run.stop_requested',
                stream: `run:${childRun.runId}`,
                sessionKey: childRun.sessionKey,
                runId: childRun.runId,
                cwd: childRun.cwd,
                payload: { runId: childRun.runId, reason: p.reason ?? 'task_cancel' }
              })
            )
            effects.push(
              makeEffect(cmd, 0, {
                kind: 'provider.run.stop',
                runId: childRun.runId,
                payload: { runId: childRun.runId },
                state: 'pending'
              })
            )
          }
        }
      }
      return acceptDecision(cmd, events, effects, { taskId: task.taskId, approved: p.approved })
    }

    case 'task.settle': {
      if (cmd.actor !== 'system' && !cmd.actor.startsWith('effect:')) {
        return retryableReject('device_not_authorized')
      }
      const p = cmd.payload
      const task = view.getTask?.(p.taskId)
      if (!task) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
      if (isTerminalTaskStatus(task.status)) return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
      const event = makeEvent(cmd, 0, {
        type: 'task.settled',
        stream: `session:${task.parentSessionKey}`,
        sessionKey: task.parentSessionKey,
        runId: task.childRunId ?? task.parentRunId,
        cwd: task.cwd,
        payload: {
          taskId: task.taskId,
          status: p.status,
          ...(p.summary !== undefined ? { summary: p.summary } : {}),
          ...(p.reason ? { reason: p.reason } : {}),
          settledAt: p.settledAt ?? cmd.at
        },
        evidence: p.evidence ?? [`task-result:${task.taskId}`]
      })
      return acceptDecision(cmd, [event], [], { taskId: task.taskId, status: p.status })
    }
  }
}
