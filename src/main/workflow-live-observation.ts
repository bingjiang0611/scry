import { randomUUID } from 'node:crypto'
import type { ProviderId } from '../shared/provider'
import type {
  WorkflowLiveAttempt,
  WorkflowLiveDiagnostics,
  WorkflowLiveObservation,
  WorkflowLiveStatus
} from '../shared/workflow'
import { WORKFLOW_LIVE_MAX_IDS, WORKFLOW_LIVE_MAX_ID_LENGTH } from '../shared/workflow'

const MAX_PROGRESS_COUNT = 10_000

type LiveIdentity = {
  taskId: string
  attemptId: string
  runId: string
  providerId: ProviderId
}

/** Attempt-scoped, non-content observations, never scheduling/settlement authority. */
export class WorkflowLiveObservationTracker {
  readonly epoch = randomUUID()
  private readonly tools = new Set<string>()
  private readonly permissions = new Set<string>()
  private readonly businessQuestions = new Set<string>()
  private readonly quotas = new Set<string>()
  private readonly sources = new Set<'pi_native' | 'claude_native' | 'main_permission' | 'main_question' | 'main_quota'>()
  private observedAt: number
  private modelProgressCount = 0
  private lastGenuineProgressAt: number | undefined
  private lastActivityStatus: WorkflowLiveStatus = 'unavailable'
  private truncated = false
  private closed = false

  constructor(private readonly identity: LiveIdentity, private readonly now: () => number = () => Date.now()) {
    this.observedAt = this.now()
  }

  observe(observation: WorkflowLiveObservation): boolean {
    if (this.closed) return false
    if (observation.source === 'pi_native' && this.identity.providerId !== 'pi') return false
    if (observation.source === 'claude_native' && (this.identity.providerId !== 'claude' || (observation.kind !== 'model_progress' && observation.kind !== 'tool_activity' && observation.kind !== 'tool_returned'))) return false
    if (observation.source === 'main_question' && (observation.kind !== 'business_question_started' && observation.kind !== 'business_question_ended')) return false
    if (observation.source === 'main_quota' && (observation.kind !== 'quota_started' && observation.kind !== 'quota_ended')) return false
    const at = this.now()
    switch (observation.kind) {
      case 'tool_activity':
        if (observation.source !== 'claude_native') return false
        if (!observation.toolCallId || this.tools.has(observation.toolCallId)) return false
        if (observation.toolCallId.length > WORKFLOW_LIVE_MAX_ID_LENGTH || this.tools.size >= WORKFLOW_LIVE_MAX_IDS) return this.markTruncated(observation.source, at)
        this.tools.add(observation.toolCallId)
        this.lastActivityStatus = 'tool_wait'
        break
      case 'tool_returned':
        if (observation.source !== 'claude_native') return false
        if (observation.toolCallId.length > WORKFLOW_LIVE_MAX_ID_LENGTH) return this.markTruncated(observation.source, at)
        if (!this.tools.delete(observation.toolCallId)) return false
        this.lastActivityStatus = 'unknown'
        break
      case 'tool_started':
        if (observation.source !== 'pi_native') return false
        if (!observation.toolCallId || this.tools.has(observation.toolCallId)) return false
        if (observation.toolCallId.length > WORKFLOW_LIVE_MAX_ID_LENGTH || this.tools.size >= WORKFLOW_LIVE_MAX_IDS) return this.markTruncated(observation.source, at)
        this.tools.add(observation.toolCallId)
        this.lastActivityStatus = 'tool_wait'
        break
      case 'tool_ended':
        if (observation.source !== 'pi_native') return false
        if (observation.toolCallId.length > WORKFLOW_LIVE_MAX_ID_LENGTH) return this.markTruncated(observation.source, at)
        if (!this.tools.delete(observation.toolCallId)) return false
        this.lastActivityStatus = 'unknown'
        break
      case 'permission_started':
        if (!observation.permissionId || this.permissions.has(observation.permissionId)) return false
        if (observation.permissionId.length > WORKFLOW_LIVE_MAX_ID_LENGTH || this.permissions.size >= WORKFLOW_LIVE_MAX_IDS) return this.markTruncated(observation.source, at)
        this.permissions.add(observation.permissionId)
        this.lastActivityStatus = 'permission_wait'
        break
      case 'permission_ended':
        if (observation.permissionId.length > WORKFLOW_LIVE_MAX_ID_LENGTH) return this.markTruncated(observation.source, at)
        if (!this.permissions.delete(observation.permissionId)) return false
        this.lastActivityStatus = 'unknown'
        break
      case 'business_question_started':
        if (observation.source !== 'main_question' || !observation.questionId || this.businessQuestions.has(observation.questionId)) return false
        if (observation.questionId.length > WORKFLOW_LIVE_MAX_ID_LENGTH || this.businessQuestions.size >= WORKFLOW_LIVE_MAX_IDS) return this.markTruncated(observation.source, at)
        this.businessQuestions.add(observation.questionId)
        this.lastActivityStatus = 'business_question'
        break
      case 'business_question_ended':
        if (observation.source !== 'main_question' || observation.questionId.length > WORKFLOW_LIVE_MAX_ID_LENGTH) return this.markTruncated(observation.source, at)
        if (!this.businessQuestions.delete(observation.questionId)) return false
        this.lastActivityStatus = 'unknown'
        break
      case 'quota_started':
        if (observation.source !== 'main_quota' || !observation.quotaId || this.quotas.has(observation.quotaId)) return false
        if (observation.quotaId.length > WORKFLOW_LIVE_MAX_ID_LENGTH || this.quotas.size >= WORKFLOW_LIVE_MAX_IDS) return this.markTruncated(observation.source, at)
        this.quotas.add(observation.quotaId)
        this.lastActivityStatus = 'quota_wait'
        break
      case 'quota_ended':
        if (observation.source !== 'main_quota' || observation.quotaId.length > WORKFLOW_LIVE_MAX_ID_LENGTH) return this.markTruncated(observation.source, at)
        if (!this.quotas.delete(observation.quotaId)) return false
        this.lastActivityStatus = 'unknown'
        break
      case 'model_progress':
        if (this.modelProgressCount === MAX_PROGRESS_COUNT) this.truncated = true
        else this.modelProgressCount++
        this.lastGenuineProgressAt = at
        this.lastActivityStatus = 'model_progress'
        break
    }
    this.sources.add(observation.source)
    this.observedAt = at
    return true
  }

  private markTruncated(source: WorkflowLiveObservation['source'], at: number): boolean {
    if (this.truncated) return false
    this.truncated = true
    this.sources.add(source)
    this.observedAt = at
    return true
  }

  close(): void { this.closed = true }

  snapshot(): WorkflowLiveAttempt {
    const status: WorkflowLiveStatus = this.businessQuestions.size > 0
      ? 'business_question'
      : this.permissions.size > 0
        ? 'permission_wait'
        : this.quotas.size > 0
          ? 'quota_wait'
          : this.tools.size > 0
            ? 'tool_wait'
            : this.truncated ? 'unknown' : this.lastActivityStatus
    return {
      ...this.identity,
      epoch: this.epoch,
      source: [...this.sources],
      status,
      trackedToolCount: this.tools.size,
      trackedPermissionCount: this.permissions.size,
      trackedBusinessQuestionCount: this.businessQuestions.size,
      trackedQuotaCount: this.quotas.size,
      truncated: this.truncated,
      activeToolIds: [...this.tools],
      activePermissionIds: [...this.permissions],
      activeBusinessQuestionIds: [...this.businessQuestions],
      activeQuotaIds: [...this.quotas],
      modelProgressCount: this.modelProgressCount,
      observedAt: this.observedAt,
      ...(this.lastGenuineProgressAt === undefined ? {} : { lastGenuineProgressAt: this.lastGenuineProgressAt })
    }
  }
}

export function workflowLiveDiagnostics(
  attempts: readonly WorkflowLiveAttempt[],
  context: Pick<WorkflowLiveDiagnostics, 'epoch' | 'revision' | 'observedAt'>
): WorkflowLiveDiagnostics {
  const status: WorkflowLiveStatus = attempts.some(attempt => attempt.status === 'business_question')
    ? 'business_question'
    : attempts.some(attempt => attempt.status === 'permission_wait')
      ? 'permission_wait'
      : attempts.some(attempt => attempt.status === 'quota_wait')
        ? 'quota_wait'
        : attempts.some(attempt => attempt.status === 'tool_wait')
          ? 'tool_wait'
          : attempts.some(attempt => attempt.status === 'unknown')
            ? 'unknown'
            : attempts.some(attempt => attempt.status === 'model_progress') ? 'model_progress' : 'unavailable'
  return {
    ...context,
    status,
    coverage: attempts.some(attempt => attempt.source.length > 0) ? 'partial' : 'unavailable',
    automaticStall: 'unsupported',
    attemptCount: attempts.length,
    truncated: attempts.length > WORKFLOW_LIVE_MAX_IDS || attempts.some(attempt => attempt.truncated),
    attempts: attempts.slice(-WORKFLOW_LIVE_MAX_IDS)
  }
}

/** Scoped feed lifecycle shared with the Runner; late observations cannot
 * mutate a replacement owner and physical close remains idempotent. */
export function trackWorkflowLiveAttempt(trackers: Map<string, Map<string, WorkflowLiveObservationTracker>>, identity: LiveIdentity & { workflowId: string },
  now: () => number, changed: () => void, current: () => boolean) {
  const { workflowId, ...attemptIdentity } = identity
  const tracker = new WorkflowLiveObservationTracker(attemptIdentity, now)
  const attempts = trackers.get(workflowId) ?? new Map<string, WorkflowLiveObservationTracker>()
  attempts.set(identity.attemptId, tracker)
  trackers.set(workflowId, attempts)
  const releaseLive = (): void => {
    tracker.close()
    if (!attempts.delete(identity.attemptId)) return
    if (attempts.size === 0) trackers.delete(workflowId)
    changed()
  }
  const observe = (observation: WorkflowLiveObservation): void => {
    if (!current() || !tracker.observe(observation)) return
    changed()
  }
  return { observe, releaseLive }
}
