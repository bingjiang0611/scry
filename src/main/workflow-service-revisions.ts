import type { WorkflowPlanPreview, WorkflowApproval, WorkflowProgress } from '../shared/workflow'
import { workflowRecoveryCopy } from '../shared/constants/copy'
import type { Receipt } from './workflow-service-contracts'
import { WorkflowServicePlanning } from './workflow-service-planning'
import { assertWorkflowRevisionChange, type WorkflowRevisionTarget } from './workflow-revisions'

export class WorkflowServiceRevisions extends WorkflowServicePlanning {
  private readonly revisions = new Map<string, Receipt<WorkflowProgress>>()

  /** Main-only revision admission. No renderer command/path execution surface is
   * introduced; callers must supply and approve the complete frozen program. */
  async revise(preview: WorkflowPlanPreview, approval: WorkflowApproval, target: WorkflowRevisionTarget, commandId: string): Promise<WorkflowProgress> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    await this.assertFrozen(preview)
    if (approval.workflowId !== preview.workflowId || approval.programRevision !== preview.programRevision || !/^[A-Za-z0-9_-]{1,96}$/.test(commandId)) throw new Error(workflowRecoveryCopy.fingerprint)
    const fingerprint = JSON.stringify({ preview, approval, target })
    return this.receipt(this.revisions, commandId, fingerprint, async () => {
      const record = await this.options.store.load(preview.workflowId)
      if (!record) throw new Error(workflowRecoveryCopy.legacy)
      await this.assertFrozen(record.preview)
      if (!record.execution?.segments.some(segment => segment.commandId === commandId)) {
        this.runner.assertRecovery(record)
        assertWorkflowRevisionChange(record, preview, target)
        await Promise.all(preview.program.roles.map(role => this.capability(role, preview.workspace, true)))
      }
      this.assertAdmissionGeneration(generation)
      this.runner.approve(preview, approval)
      return this.progressSnapshot(await this.runner.revise(preview, approval, target, commandId, () => this.assertAdmissionGeneration(generation)))
    })
  }

}
