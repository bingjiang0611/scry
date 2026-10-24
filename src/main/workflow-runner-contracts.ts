import type { AgentPermissionMode } from '../shared/runtime'
import type { WorkflowApproval, WorkflowPlanPreview, WorkflowLiveObservation, WorkflowProgress, WorkflowRoleBinding } from '../shared/workflow'
import type { WorkflowReplicaRun, WorkflowSystemHost } from './workflow-system-host'
import type { WorkflowStore } from './workflow-store'
import type { WorkflowSlots } from './workflow-slots'

export interface WorkflowProviderExecutionRequest {
  workflowId: string
  taskId: string
  attemptId: string
  role: WorkflowRoleBinding
  prompt: string
  cwd: string
  replicaRun?: WorkflowReplicaRun
  permissionMode?: AgentPermissionMode
  onObservation?: (observation: WorkflowLiveObservation) => void
}

export interface WorkflowProviderExecutionResult {
  runId: string
  status: 'completed' | 'failed' | 'blocked' | 'stopped' | 'unknown'
  output?: string
  actualModel?: string
  archiveRef?: string
  settled: boolean
  error?: string
}

export interface WorkflowProviderExecution {
  result: Promise<WorkflowProviderExecutionResult>
  runId?: string
  /** Optional later convergence signal. A missing signal means the slot remains occupied. */
  settled?: Promise<void>
  stop: () => boolean
}

export class WorkflowScopeError extends Error {
  constructor(message: string, readonly settled: boolean, readonly providerDispatch?: 'not_attempted') { super(message); this.name = 'WorkflowScopeError' }
}

/** Owned by one canonical start; mark before entering Provider code, even if run() throws. */
export class WorkflowDispatch {
  private attempted = false
  private refused?: WorkflowScopeError
  readonly onProviderDispatchAttempt = (): void => {
    if (this.refused) throw this.refused
    this.attempted = true
  }
  rejected(error: unknown): WorkflowScopeError {
    const failure = new WorkflowScopeError(String(error), !this.attempted, this.attempted ? undefined : 'not_attempted')
    // Canonical startup schedules async work: fence a delayed run() before claiming no dispatch.
    if (!this.attempted) this.refused = failure
    return failure
  }
}

export type WorkflowProviderExecutor = (request: WorkflowProviderExecutionRequest) => WorkflowProviderExecution

export interface WorkflowRunnerOptions {
  store: WorkflowStore
  slots?: WorkflowSlots
  execute: WorkflowProviderExecutor
  systems?: WorkflowSystemHost
  now?: () => number
  onProgress?: (progress: WorkflowProgress) => void
  onLifecycle?: () => void
  beforeDispatch?: (role: WorkflowRoleBinding, workspace: string) => Promise<void>
}


export function assertWorkflowApproval(preview: WorkflowPlanPreview, approval: WorkflowApproval): void {
  if (approval.workflowId !== preview.workflowId || approval.programRevision !== preview.programRevision) {
    throw new Error('计划已变化，必须重新预览并确认')
  }
  if (preview.state !== 'ready') throw new Error('当前计划包含不可用能力，不能确认')
}
