export * from './workflow-runner-contracts'
export { WorkflowSlots } from './workflow-slots'
import { workflowProgressSnapshot } from '../shared/workflow'
import type { WorkflowApproval, WorkflowPlanPreview, WorkflowProgress } from '../shared/workflow'
import type { WorkflowResumeResult, WorkflowRetryTarget } from '../shared/workflow-api'
import { workflowRecoveryCopy, workflowRetryCopy } from '../shared/constants/copy'
import { assertWorkflowApproval } from './workflow-runner-contracts'
import { assertWorkflowRetryTarget, validateWorkflowRetryTarget } from './workflow-retry'
import { WorkflowRunnerKernel } from './workflow-runner-kernel'
import { assertWorkflowRevisionChange, type WorkflowRevisionTarget } from './workflow-revisions'
import { prepareWorkflowRevisionReuse } from './workflow-revision-reuse'
import { workflowRevisionCopy } from '../shared/constants/workflow-revision-copy'

export class WorkflowRunner extends WorkflowRunnerKernel {
  approve(preview: WorkflowPlanPreview, approval: WorkflowApproval): void {
    assertWorkflowApproval(preview, approval)
    this.approvals.set(preview.workflowId, approval)
  }

  invalidate(workflowId: string): void { this.approvals.delete(workflowId) }

  async start(preview: WorkflowPlanPreview, approval: WorkflowApproval): Promise<WorkflowProgress> {
    return this.run(preview, approval)
  }
  async resume(preview: WorkflowPlanPreview, approval: WorkflowApproval, commandId: string): Promise<WorkflowResumeResult> {
    if (this.active.has(preview.workflowId)) throw new Error(workflowRecoveryCopy.owner)
    const record = await this.store.load(preview.workflowId)
    if (!record) return { state: 'nothing_to_resume', progress: null }
    const accepted = record.execution?.segments.find(segment => segment.commandId === commandId)
    if (accepted) {
      if (accepted.mode !== 'continue') throw new Error(workflowRetryCopy.command)
      return { state: 'continued', progress: workflowProgressSnapshot(record.progress) }
    }
    if (record.progress.state === 'completed') return { state: 'nothing_to_resume', progress: workflowProgressSnapshot(record.progress) }
    this.assertRecovery(record)
    if (record.execution!.segments.length >= 256) throw new Error(workflowRecoveryCopy.limit)
    return { state: 'continued', progress: await this.run(preview, approval, { record, commandId }) }
  }
  async revise(preview: WorkflowPlanPreview, approval: WorkflowApproval, target: WorkflowRevisionTarget, commandId: string, beforeClaim?: () => void): Promise<WorkflowProgress> {
    assertWorkflowApproval(preview, approval)
    const record = await this.store.load(preview.workflowId)
    if (!record?.execution) throw new Error(workflowRecoveryCopy.legacy)
    const accepted = record.execution.segments.find(segment => segment.commandId === commandId)
    if (accepted) {
      const revision = record.revisions?.find(value => value.segmentId === accepted.id)
      if (accepted.mode !== 'revision' || accepted.expectedRevision !== target.expectedRevision || JSON.stringify(revision?.preview.program) !== JSON.stringify(preview.program) || JSON.stringify(revision?.approval) !== JSON.stringify(approval)) throw new Error(workflowRetryCopy.command)
      return workflowProgressSnapshot(record.progress)
    }
    this.assertRecovery(record)
    assertWorkflowRevisionChange(record, preview, target)
    if (record.execution.segments.length >= 256) throw new Error(workflowRecoveryCopy.limit)
    const reuse = await prepareWorkflowRevisionReuse(this.store, record, preview, this.systems, commandId)
    this.assertRecovery(record)
    if (this.active.has(preview.workflowId)) throw new Error(workflowRevisionCopy.stale)
    beforeClaim?.()
    return this.run(preview, approval, { record, commandId, revision: { target, reuse } })
  }
  async retry(preview: WorkflowPlanPreview, approval: WorkflowApproval, target: WorkflowRetryTarget, commandId: string): Promise<WorkflowProgress> {
    target = validateWorkflowRetryTarget(target)
    if (approval.workflowId !== preview.workflowId || approval.programRevision !== preview.programRevision) throw new Error(workflowRecoveryCopy.fingerprint)
    const record = await this.store.load(preview.workflowId)
    if (!record?.execution) throw new Error(workflowRecoveryCopy.legacy)
    if (JSON.stringify(record.preview.program) !== JSON.stringify(preview.program)) throw new Error(workflowRecoveryCopy.fingerprint)
    const accepted = record.execution.segments.find(segment => segment.commandId === commandId)
    if (accepted) {
      if (accepted.mode !== 'retry' || JSON.stringify(validateWorkflowRetryTarget(accepted.retry)) !== JSON.stringify(target)) throw new Error(workflowRetryCopy.command)
      return workflowProgressSnapshot(record.progress)
    }
    this.assertRecovery(record)
    assertWorkflowRetryTarget(record, target)
    if (record.execution.segments.length >= 256) throw new Error(workflowRecoveryCopy.limit)
    return this.run(preview, approval, { record, commandId, retry: target })
  }
}
