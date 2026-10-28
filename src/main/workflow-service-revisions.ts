import type { WorkflowPlanPreview, WorkflowApproval, WorkflowProgress } from '../shared/workflow'
import type { WorkflowRevisionDraft } from '../shared/workflow-api'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import { makePlanPreview, validateWorkflowProgram, workflowRevision, workflowSystemSourceBody } from './workflow-program'
import { validateWorkflowRevisionDraft, validateWorkflowRevisionTarget } from './workflow-revision-draft'
import { workflowRecoveryCopy } from '../shared/constants/copy'
import type { Receipt } from './workflow-service-contracts'
import { WorkflowServicePlanning } from './workflow-service-planning'
import { assertWorkflowRevisionChange, type WorkflowRevisionTarget } from './workflow-revisions'

export class WorkflowServiceRevisions extends WorkflowServicePlanning {
  private readonly revisions = new Map<string, Receipt<WorkflowProgress>>()
  private readonly revisionCandidates = new Map<string, { preview: WorkflowPlanPreview; expectedRevision: number }>()

  async prepareRevision(input: WorkflowRevisionDraft): Promise<WorkflowPlanPreview> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    const draft = validateWorkflowRevisionDraft(input)
    const record = await this.options.store.load(draft.workflowId)
    if (!record) throw new Error(workflowRecoveryCopy.legacy)
    await this.assertFrozen(record.preview)
    this.runner.assertRecovery(record)
    const target = { expectedRevision: draft.expectedRevision }
    if (target.expectedRevision !== record.progress.revision) throw new Error(copy.stale)
    const capabilities = await Promise.all(draft.roles.map(role => this.capability(role, record.preview.workspace)))
    const roles = draft.roles.map((role, index) => ({ ...role, runtimeIdentity: capabilities[index].runtimeIdentity }))
    // A body edit is a new governing program, not a mutation/publication of its
    // source template. The original frozen template remains in revision history.
    const compiled = validateWorkflowProgram({ schemaVersion: record.preview.program.schemaVersion,
      workflowId: draft.workflowId, programRevision: 'preparing', workspace: record.preview.workspace,
      userGoal: draft.userGoal, roles, body: draft.body })
    const prepared = await this.prepareSystems({ ...compiled, body: workflowSystemSourceBody(compiled.body) })
    const { programRevision: _revision, ...source } = prepared
    const program = { ...source, programRevision: workflowRevision(source) }
    const preview = { ...makePlanPreview(program, capabilities, roles.find(role => role.role === 'orchestrator')!),
      ...(record.preview.planningSize ? { planningSize: record.preview.planningSize } : {}) }
    assertWorkflowRevisionChange(record, preview, target)
    this.assertAdmissionGeneration(generation)
    // Candidates are memory-only and bounded. Eviction/restart requires another
    // review; an accepted command instead resolves its immutable durable receipt.
    const key = preview.workflowId + ':' + preview.programRevision
    this.revisionCandidates.delete(key)
    if (this.revisionCandidates.size >= 32) this.revisionCandidates.delete(this.revisionCandidates.keys().next().value!)
    this.revisionCandidates.set(key, { preview, expectedRevision: target.expectedRevision })
    return structuredClone(preview)
  }

  async revisePrepared(workflowId: string, approval: WorkflowApproval, target: WorkflowRevisionTarget, commandId: string): Promise<WorkflowProgress> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    target = validateWorkflowRevisionTarget(target)
    if (workflowId !== approval.workflowId) throw new Error(workflowRecoveryCopy.fingerprint)
    const candidate = this.revisionCandidates.get(workflowId + ':' + approval.programRevision)
    if (candidate) {
      if (candidate.expectedRevision !== target.expectedRevision) throw new Error(copy.stale)
      return this.revise(candidate.preview, approval, target, commandId)
    }
    const record = await this.options.store.load(workflowId)
    const segment = record?.execution?.segments.find(value => value.commandId === commandId && value.mode === 'revision')
    const accepted = segment && record?.revisions?.find(value => value.segmentId === segment.id)
    if (!accepted || accepted.preview.programRevision !== approval.programRevision) throw new Error(copy.candidateMissing)
    this.assertAdmissionGeneration(generation)
    return this.revise(accepted.preview, approval, target, commandId)
  }

  /** Main-only full-preview admission. Renderer calls use revisePrepared and
   * cannot supply their own frozen runtime, capability or native authority. */
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
        this.assertAdmissionGeneration(generation)
        this.runner.approve(preview, approval)
      }
      this.assertAdmissionGeneration(generation)
      return this.progressSnapshot(await this.runner.revise(preview, approval, target, commandId, () => this.assertAdmissionGeneration(generation)))
    })
  }

}
