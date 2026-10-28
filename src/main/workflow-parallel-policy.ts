import { createHash } from 'node:crypto'
import type { WorkflowControlFrame, WorkflowStopProvenance } from '../shared/workflow'
import type { WorkflowStopTarget } from '../shared/workflow-api'

/** Transient admission only. Physical stops require a separate durable receipt. */
export class WorkflowAdmissionFence {
  readonly targets = new Set<WorkflowStopTarget>()
  private stopped = false

  constructor(private readonly parent?: WorkflowAdmissionFence) {}

  stop(): void { this.stopped = true }
  isStopped(): boolean { return this.stopped || Boolean(this.parent?.isStopped()) }
  addTarget(target: WorkflowStopTarget): void {
    this.targets.add(target)
    this.parent?.addTarget(target)
  }
  removeTarget(target: WorkflowStopTarget): void {
    this.targets.delete(target)
    this.parent?.removeTarget(target)
  }
}

export type WorkflowParallelFailureTrigger = {
  nodeId: string
  phase: WorkflowControlFrame['phase']
  /** Actual enclosing parallel frame, not a task-derived identity. */
  frameId: string
}
export type WorkflowParallelFailure = {
  policy: 'fail_fast'
  admission: WorkflowAdmissionFence
  trigger: WorkflowParallelFailureTrigger
}

export function workflowParallelFailureProvenance(trigger: WorkflowParallelFailureTrigger): WorkflowStopProvenance {
  return { source: 'auto', policy: 'fail_fast', trigger }
}

export function workflowParallelFailureCommandId(workflowId: string, trigger: WorkflowParallelFailureTrigger, target?: WorkflowStopTarget): string {
  const digest = createHash('sha256').update(JSON.stringify({ workflowId, frameId: trigger.frameId,
    nodeId: trigger.nodeId, phase: trigger.phase, target: target ? { kind: target.kind, id: target.id } : null })).digest('hex').slice(0, 48)
  return `auto-fail-fast-${digest}`
}
