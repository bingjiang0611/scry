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
  private readonly sources = new Set<'pi_native' | 'claude_native' | 'main_permission'>()
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
    const status: WorkflowLiveStatus = this.permissions.size > 0
      ? 'permission_wait'
      : this.tools.size > 0
        ? 'tool_wait'
        : this.truncated ? 'unknown' : this.lastActivityStatus
    return {
      ...this.identity,
      epoch: this.epoch,
      source: [...this.sources],
      status,
      trackedToolCount: this.tools.size,
      truncated: this.truncated,
      activeToolIds: [...this.tools],
      activePermissionIds: [...this.permissions],
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
  const status: WorkflowLiveStatus = attempts.some(attempt => attempt.status === 'permission_wait')
    ? 'permission_wait'
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
