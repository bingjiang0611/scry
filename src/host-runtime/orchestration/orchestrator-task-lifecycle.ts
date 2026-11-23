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
import { isTerminalRunLifecycle } from './run-transitions'
import {
  DEFAULT_PENDING_TTL_MS,
  PROMPT_PREVIEW_MAX_CHARS,
  USER_TEXT_PREVIEW_MAX_CHARS,
  isPeerActor,
  isTerminalTaskStatus,
  type PendingOrchestrationEvent,
  type PendingOutboxEffect,
  type RunProjectionRow
} from './types'

export function isCallerRunActive(run: RunProjectionRow | undefined): boolean {
  if (!run) return false
  if (isTerminalRunLifecycle(run.lifecycle)) return false
  if (run.stopState === 'requested') return false
  return true
}

export function decideTaskConfirm(
  cmd: Extract<OrchestrationCommand, { type: 'task.confirm' }>,
  view: OrchestratorReadView
): DecisionResult {
  if (!isPeerActor(cmd.actor)) return retryableReject('device_not_authorized')
  const p = cmd.payload
  const task = view.getTask?.(p.taskId)
  if (!task) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
  if (task.status !== 'awaiting_confirmation') return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
  if (task.confirmationQuestionId !== p.questionId) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
  const interaction = view.getInteraction(task.parentRunId, p.questionId)
  if (!interaction || interaction.state !== 'open') return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })

  const events: PendingOrchestrationEvent[] = [
    makeEvent(cmd, 0, {
      type: 'run.question_answered',
      stream: `run:${task.parentRunId}`,
      sessionKey: task.parentSessionKey,
      runId: task.parentRunId,
      cwd: task.cwd,
      payload: {
        runId: task.parentRunId,
        questionId: p.questionId,
        answerId: p.answerId,
        answerSha256: p.answerSha256,
        answeredBy: cmd.actor
      }
    }),
    makeEvent(cmd, 1, {
      type: 'run.question_closed',
      stream: `run:${task.parentRunId}`,
      sessionKey: task.parentSessionKey,
      runId: task.parentRunId,
      cwd: task.cwd,
      payload: {
        runId: task.parentRunId,
        questionId: p.questionId,
        reason: p.approved ? 'approved' : 'declined'
      }
    })
  ]

  if (!p.approved) {
    events.push(
      makeEvent(cmd, 2, {
        type: 'task.declined',
        stream: `session:${task.parentSessionKey}`,
        sessionKey: task.parentSessionKey,
        runId: task.parentRunId,
        cwd: task.cwd,
        payload: { taskId: task.taskId, reason: p.reason ?? 'user_declined', answeredBy: cmd.actor }
      })
    )
    return acceptDecision(cmd, events, [], { taskId: task.taskId, status: 'declined' })
  }

  const parentRun = view.getRun(task.parentRunId)
  if (!isCallerRunActive(parentRun)) return retryableReject('caller_not_active')
  if (!view.isProjectDelegationEnabled?.(task.cwd)) return retryableReject('delegation_disabled')
  if (task.permissionMode === 'full_access' && !view.isSessionFullAccessEnabled?.(task.parentSessionKey)) {
    return retryableReject('full_access_not_enabled')
  }
  const limits = view.delegationLimits?.() ?? DEFAULT_DELEGATION_LIMITS
  if ((view.countNonTerminalAgentRuns?.() ?? 0) >= limits.maxHostAgentRuns) {
    return retryableReject('limit_exceeded')
  }
  if (!p.childSessionKey || !p.childRunId) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })

  const parentSession = view.getSession(task.parentSessionKey)
  const rootSessionKey = parentSession?.rootSessionKey ?? task.parentSessionKey
  const lineage = {
    kind: 'delegated' as const,
    source: { sessionKey: task.parentSessionKey, runId: task.parentRunId },
    taskId: task.taskId
  }

  const childCmdMeta = {
    ...cmd,
    actor: task.actor,
    principal: task.principal,
    via: task.via,
    actorRunId: task.parentRunId
  }

  events.push(
    makeEvent(childCmdMeta, 2, {
      type: 'session.created',
      stream: `session:${p.childSessionKey}`,
      sessionKey: p.childSessionKey,
      cwd: task.cwd,
      payload: {
        sessionKey: p.childSessionKey,
        conversationId: p.childSessionKey,
        provider: task.provider,
        profile: task.profile,
        cwd: task.cwd,
        title: task.title,
        parentSessionKey: task.parentSessionKey,
        rootSessionKey,
        lineage,
        createdBy: task.actor
      }
    }),
    makeEvent(childCmdMeta, 3, {
      type: 'run.intent_recorded',
      stream: `run:${p.childRunId}`,
      sessionKey: p.childSessionKey,
      runId: p.childRunId,
      cwd: task.cwd,
      payload: {
        runId: p.childRunId,
        sessionKey: p.childSessionKey,
        provider: task.provider,
        profile: task.profile,
        cwd: task.cwd,
        origin: 'agent',
        parentRunId: task.parentRunId,
        permissionMode: task.permissionMode,
        ...(task.body ? { body: task.body } : {}),
        ...(task.title ? { promptPreview: truncatePreview(task.title, PROMPT_PREVIEW_MAX_CHARS) } : {})
      }
    }),
    makeEvent(childCmdMeta, 4, {
      type: 'turn.began',
      stream: `session:${p.childSessionKey}`,
      sessionKey: p.childSessionKey,
      runId: p.childRunId,
      cwd: task.cwd,
      payload: {
        sessionKey: p.childSessionKey,
        runId: p.childRunId,
        ordinal: 1,
        ordinalOrigin: 'native',
        userTextPreview: truncatePreview(task.title, USER_TEXT_PREVIEW_MAX_CHARS),
        author: 'agent'
      }
    }),
    makeEvent(cmd, 5, {
      type: 'task.child_bound',
      stream: `session:${task.parentSessionKey}`,
      sessionKey: task.parentSessionKey,
      runId: p.childRunId,
      cwd: task.cwd,
      payload: {
        taskId: task.taskId,
        childSessionKey: p.childSessionKey,
        childRunId: p.childRunId,
        answeredBy: cmd.actor
      }
    })
  )

  const boundedPendingTtlMs = Math.min(Math.max(1, p.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS), DEFAULT_PENDING_TTL_MS)
  const effects: PendingOutboxEffect[] = [
    makeEffect(childCmdMeta, 0, {
      kind: 'provider.run.start',
      runId: p.childRunId,
      payload: {
        runId: p.childRunId,
        sessionKey: p.childSessionKey,
        provider: task.provider,
        profile: task.profile,
        cwd: task.cwd,
        taskId: task.taskId,
        parentRunId: task.parentRunId,
        permissionMode: task.permissionMode,
        ...(task.targetModel ? { targetModel: task.targetModel } : {}),
        ...(task.targetEffort ? { targetEffort: task.targetEffort } : {}),
        ...(task.body ? { body: task.body } : {})
      },
      state: 'pending',
      expiresAt: cmd.at + boundedPendingTtlMs
    })
  ]
  return acceptDecision(cmd, events, effects, {
    taskId: task.taskId,
    status: 'queued',
    childSessionKey: p.childSessionKey,
    childRunId: p.childRunId
  })
}

export function decideRunStop(
  cmd: Extract<OrchestrationCommand, { type: 'run.stop' }>,
  view: OrchestratorReadView
): DecisionResult {
  const target = view.getRun(cmd.payload.runId)
  if (!target) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
  if (isTerminalRunLifecycle(target.lifecycle)) return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })

  const events: PendingOrchestrationEvent[] = [
    makeEvent(cmd, 0, {
      type: 'run.stop_requested',
      stream: `run:${target.runId}`,
      sessionKey: target.sessionKey,
      runId: target.runId,
      cwd: target.cwd,
      payload: { runId: target.runId, ...(cmd.payload.reason ? { reason: cmd.payload.reason } : {}) }
    })
  ]
  const shadowOnly = Boolean(cmd.payload.shadowOnly)
  const effects: PendingOutboxEffect[] = [
    makeEffect(cmd, 0, {
      kind: 'provider.run.stop',
      runId: target.runId,
      payload: { runId: target.runId, ...(shadowOnly ? { shadowOnly: true } : {}) },
      state: shadowOnly ? 'done' : 'pending',
      leaseOwner: shadowOnly ? 'shadow:no-dispatch' : null,
      claimedAt: shadowOnly ? cmd.at : null
    })
  ]
  const visited = new Set<string>([target.runId])
  const queue = [target.runId]
  while (queue.length > 0) {
    const parentId = queue.shift()!
    for (const child of view.listNonTerminalChildRuns(parentId)) {
      if (visited.has(child.runId)) continue
      visited.add(child.runId)
      queue.push(child.runId)
      events.push(
        makeEvent(cmd, events.length, {
          type: 'run.stop_requested',
          stream: `run:${child.runId}`,
          sessionKey: child.sessionKey,
          runId: child.runId,
          cwd: child.cwd,
          payload: { runId: child.runId, cascadeRoot: target.runId }
        })
      )
      effects.push(
        makeEffect(cmd, effects.length, {
          kind: 'provider.run.stop',
          runId: child.runId,
          payload: { runId: child.runId, cascadeRoot: target.runId, ...(shadowOnly ? { shadowOnly: true } : {}) },
          state: shadowOnly ? 'done' : 'pending',
          leaseOwner: shadowOnly ? 'shadow:no-dispatch' : null,
          claimedAt: shadowOnly ? cmd.at : null
        })
      )
    }
  }
  return acceptDecision(cmd, events, effects, { runId: target.runId, cascadedCount: events.length - 1 })
}

export function decideSessionStopSubtasks(
  cmd: Extract<OrchestrationCommand, { type: 'session.stop_subtasks' }>,
  view: OrchestratorReadView
): DecisionResult {
  if (!isPeerActor(cmd.actor)) return retryableReject('device_not_authorized')
  const events: PendingOrchestrationEvent[] = []
  const effects: PendingOutboxEffect[] = []
  const stoppedRunIds = new Set<string>()
  for (const task of view.listTasksByParentSession?.(cmd.payload.sessionKey) ?? []) {
    if (isTerminalTaskStatus(task.status)) continue
    if (task.status === 'awaiting_confirmation') {
      if (task.confirmationQuestionId && view.getInteraction(task.parentRunId, task.confirmationQuestionId)?.state === 'open') {
        events.push(
          makeEvent(cmd, events.length, {
            type: 'run.question_closed',
            stream: `run:${task.parentRunId}`,
            sessionKey: task.parentSessionKey,
            runId: task.parentRunId,
            cwd: task.cwd,
            payload: { runId: task.parentRunId, questionId: task.confirmationQuestionId, reason: 'session_stop_subtasks' }
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
          payload: { taskId: task.taskId, status: 'cancelled', reason: cmd.payload.reason ?? 'session_stop_subtasks', settledAt: cmd.at }
        })
      )
      continue
    }
    if (task.childRunId && !stoppedRunIds.has(task.childRunId)) {
      const child = view.getRun(task.childRunId)
      if (child && !isTerminalRunLifecycle(child.lifecycle)) {
        stoppedRunIds.add(child.runId)
        events.push(
          makeEvent(cmd, events.length, {
            type: 'run.stop_requested',
            stream: `run:${child.runId}`,
            sessionKey: child.sessionKey,
            runId: child.runId,
            cwd: child.cwd,
            payload: { runId: child.runId, cascadeRoot: child.parentRunId ?? cmd.payload.sessionKey }
          })
        )
        effects.push(
          makeEffect(cmd, effects.length, {
            kind: 'provider.run.stop',
            runId: child.runId,
            payload: { runId: child.runId },
            state: 'pending'
          })
        )
      }
    }
  }
  for (const child of view.listNonTerminalChildRunsBySession(cmd.payload.sessionKey)) {
    if (stoppedRunIds.has(child.runId)) continue
    stoppedRunIds.add(child.runId)
    events.push(
      makeEvent(cmd, events.length, {
        type: 'run.stop_requested',
        stream: `run:${child.runId}`,
        sessionKey: child.sessionKey,
        runId: child.runId,
        cwd: child.cwd,
        payload: { runId: child.runId, cascadeRoot: child.parentRunId ?? cmd.payload.sessionKey }
      })
    )
    effects.push(
      makeEffect(cmd, effects.length, {
        kind: 'provider.run.stop',
        runId: child.runId,
        payload: { runId: child.runId },
        state: 'pending'
      })
    )
  }
  return acceptDecision(cmd, events, effects, { sessionKey: cmd.payload.sessionKey, stoppedCount: stoppedRunIds.size })
}

/**
 * L4 / D22: when a parent run reaches any terminal state, void all awaiting_confirmation tasks
 * and any undispatched (recorded) child runs in the same transaction; dispatched child runs continue.
 */
export function appendL4ParentEndVoidEvents(
  cmd: OrchestrationCommand,
  parentRun: RunProjectionRow,
  view: OrchestratorReadView,
  events: PendingOrchestrationEvent[]
): void {
  const tasks = view.listTasksByParentRun?.(parentRun.runId) ?? []
  for (const task of tasks) {
    if (task.status === 'awaiting_confirmation') {
      if (task.confirmationQuestionId) {
        const q = view.getInteraction(parentRun.runId, task.confirmationQuestionId)
        if (q && q.state === 'open') {
          events.push(
            makeEvent(cmd, events.length, {
              type: 'run.question_closed',
              stream: `run:${parentRun.runId}`,
              sessionKey: task.parentSessionKey,
              runId: parentRun.runId,
              cwd: task.cwd,
              payload: { runId: parentRun.runId, questionId: task.confirmationQuestionId, reason: 'caller_run_ended' }
            })
          )
        }
      }
      events.push(
        makeEvent(cmd, events.length, {
          type: 'task.settled',
          stream: `session:${task.parentSessionKey}`,
          sessionKey: task.parentSessionKey,
          runId: parentRun.runId,
          cwd: task.cwd,
          payload: { taskId: task.taskId, status: 'cancelled', reason: 'caller_run_ended', settledAt: cmd.at }
        })
      )
      continue
    }
    if (task.childRunId && !isTerminalTaskStatus(task.status)) {
      const childRun = view.getRun(task.childRunId)
      if (childRun && childRun.lifecycle === 'recorded') {
        events.push(
          makeEvent(cmd, events.length, {
            type: 'run.cancelled',
            stream: `run:${childRun.runId}`,
            sessionKey: childRun.sessionKey,
            runId: childRun.runId,
            cwd: childRun.cwd,
            payload: { runId: childRun.runId, reason: 'caller_run_ended', settledAt: cmd.at }
          })
        )
        if (childRun.sessionKey) {
          events.push(
            makeEvent(cmd, events.length, {
              type: 'turn.delivery',
              stream: `session:${childRun.sessionKey}`,
              sessionKey: childRun.sessionKey,
              runId: childRun.runId,
              cwd: childRun.cwd,
              payload: { runId: childRun.runId, delivery: 'not_sent', reason: 'caller_run_ended' }
            })
          )
        }
        events.push(
          makeEvent(cmd, events.length, {
            type: 'task.settled',
            stream: `session:${task.parentSessionKey}`,
            sessionKey: task.parentSessionKey,
            runId: childRun.runId,
            cwd: task.cwd,
            payload: { taskId: task.taskId, status: 'cancelled', reason: 'caller_run_ended', settledAt: cmd.at }
          })
        )
      }
    }
  }
}
