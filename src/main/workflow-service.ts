import type { WorkflowSizeSnapshot } from '../shared/workflow-size'
import { isWorkflowSizeGuideline } from '../shared/workflow-size'
import { workflowRecoveryCopy, workflowRetryCopy, workflowSizeCopy } from '../shared/constants/copy'
import type { WorkflowResumeResult, WorkflowRetryTarget, WorkflowStopTarget, WorkflowRestartTarget } from '../shared/workflow-api'
import { assertWorkflowRetryTarget, validateWorkflowRestartTarget, validateWorkflowRetryTarget } from './workflow-retry'
import { validateWorkflowStopTarget } from './workflow-stop'
import type { WorkflowApproval, WorkflowPlanPreview, WorkflowProgress, WorkflowProgressPage } from '../shared/workflow'
import { type WorkflowProviderExecutionResult } from './workflow-runner'
import { WorkflowServiceShutdown } from './workflow-service-shutdown'
export type { WorkflowServiceOptions, WorkflowPlanRequest, WorkflowPlanProvider, WorkflowShutdownPreparation, WorkflowShutdownPreparationOptions } from './workflow-service-contracts'

export class WorkflowService extends WorkflowServiceShutdown {
  sizeGuideline(): Promise<WorkflowSizeSnapshot> { return this.options.store.sizeGuideline() }
  async setSizeGuideline(value: unknown): Promise<WorkflowSizeSnapshot> {
    if (value !== null && !isWorkflowSizeGuideline(value)) throw new Error(workflowSizeCopy.invalidValue)
    const generation = this.admissionGeneration
    this.assertAdmissionGeneration(generation)
    const snapshot = await this.options.store.setSizeGuideline(value)
    this.assertAdmissionGeneration(generation)
    return snapshot
  }

  async approve(approval: WorkflowApproval): Promise<true> {
    await this.ensureReady()
    this.assertAdmitting()
    this.runner.approve(await this.loadPreview(approval.workflowId), approval)
    return true
  }
  async start(id: string, approval: WorkflowApproval, commandId?: string): Promise<WorkflowProgress> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    const fingerprint = JSON.stringify({ workflowId: id, programRevision: approval.programRevision })
    const start = async () => {
      const preview = await this.loadPreview(id)
      this.assertAdmissionGeneration(generation)
      const record = (await this.options.store.load(id))!
      this.assertAdmissionGeneration(generation)
      if (record.receipt) {
        if (record.receipt.commandId === commandId && record.receipt.fingerprint === fingerprint) return this.progressSnapshot(record.progress, record.stopRequests, record)
        throw new Error('工作流已有启动收据，不允许重新派发')
      }
      await Promise.all(preview.program.roles.map(role => this.capability(role, preview.workspace, true)))
      this.assertAdmissionGeneration(generation)
      if (commandId) {
        record.receipt = { commandId, fingerprint, status: 'accepted' }
        await this.options.store.save(record)
        this.assertAdmissionGeneration(generation)
      }
      return this.progressSnapshot(await this.runner.start(preview, approval))
    }
    return commandId ? this.receipt(this.starts, commandId, fingerprint, start) : start()
  }
  async resume(id: string, approval: WorkflowApproval, commandId: string): Promise<WorkflowResumeResult> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    if (approval.workflowId !== id) throw new Error(workflowRecoveryCopy.fingerprint)
    const fingerprint = JSON.stringify({ workflowId: id, programRevision: approval.programRevision })
    return this.receipt(this.resumes, commandId, fingerprint, async () => {
      const record = await this.options.store.load(id)
      if (!record) return { state: 'nothing_to_resume', progress: null }
      const preview = record.preview
      await this.assertFrozen(preview)
      if (approval.programRevision !== preview.programRevision) throw new Error(workflowRecoveryCopy.fingerprint)
      if (record.progress.state !== 'completed' && !record.execution?.segments.some(segment => segment.commandId === commandId)) {
        this.runner.assertRecovery(record)
        await Promise.all(preview.program.roles.map(role => this.capability(role, preview.workspace, true)))
      }
      this.assertAdmissionGeneration(generation)
      const result = await this.runner.resume(preview, approval, commandId)
      return result.progress ? { ...result, progress: this.progressSnapshot(result.progress, undefined, record) } : result
    })
  }
  async restartStalled(id: string, approval: WorkflowApproval, target: WorkflowRestartTarget, commandId: string): Promise<WorkflowProgress> {
    target = validateWorkflowRestartTarget(target)
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    if (approval.workflowId !== id) throw new Error(workflowRecoveryCopy.fingerprint)
    const fingerprint = JSON.stringify({ workflowId: id, programRevision: approval.programRevision, target, mode: 'restart_stalled' })
    return this.receipt(this.retries, commandId, fingerprint, async () => {
      const record = await this.options.store.load(id)
      if (!record) throw new Error(workflowRecoveryCopy.legacy)
      await this.assertFrozen(record.preview)
      if (approval.programRevision !== record.preview.programRevision) throw new Error(workflowRecoveryCopy.fingerprint)
      const accepted = record.execution?.segments.find(segment => segment.commandId === commandId)
      if (accepted) {
        if (accepted.mode !== 'restart' || JSON.stringify({ taskId: accepted.restart?.taskId, attemptId: accepted.restart?.attemptId, expectedRevision: accepted.restart?.expectedRevision }) !== JSON.stringify(target)) throw new Error(workflowRetryCopy.command)
        return this.progressSnapshot(record.progress, undefined, record)
      }
      if ((record.execution?.segments.length ?? 0) >= 256) throw new Error(workflowRecoveryCopy.limit)
      const evidence = await this.options.restartEvidence?.({ workflowId: id, taskId: target.taskId, attemptId: target.attemptId, programRevision: approval.programRevision })
      if (!evidence || evidence.state !== 'settled' || evidence.attemptId !== target.attemptId || evidence.taskId !== target.taskId) throw new Error('停滞重启证据不可用')
      await Promise.all(record.preview.program.roles.map(role => this.capability(role, record.preview.workspace, true)))
      this.assertAdmissionGeneration(generation)
      return this.progressSnapshot(await this.runner.restartStalled(record.preview, approval, target, commandId, evidence.reason), undefined, record)
    })
  }
  async retry(id: string, approval: WorkflowApproval, target: WorkflowRetryTarget, commandId: string): Promise<WorkflowProgress> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    if (approval.workflowId !== id) throw new Error(workflowRecoveryCopy.fingerprint)
    target = validateWorkflowRetryTarget(target)
    const fingerprint = JSON.stringify({ workflowId: id, programRevision: approval.programRevision, target })
    return this.receipt(this.retries, commandId, fingerprint, async () => {
      const record = await this.options.store.load(id)
      if (!record) throw new Error(workflowRecoveryCopy.legacy)
      await this.assertFrozen(record.preview)
      if (approval.programRevision !== record.preview.programRevision) throw new Error(workflowRecoveryCopy.fingerprint)
      if (!record.execution?.segments.some(segment => segment.commandId === commandId)) {
        this.runner.assertRecovery(record)
        assertWorkflowRetryTarget(record, target)
        await Promise.all(record.preview.program.roles.map(role => this.capability(role, record.preview.workspace, true)))
      }
      this.assertAdmissionGeneration(generation)
      return this.progressSnapshot(await this.runner.retry(record.preview, approval, target, commandId), undefined, record)
    })
  }
  async preview(id: string): Promise<WorkflowPlanPreview> { await this.ensureReady(); return this.loadPreview(id) }
  async stop(id: string, commandId: string): Promise<boolean> {
    await this.ensureReady()
    return this.stopReceipt(commandId, JSON.stringify({ workflowId: id, mode: 'root' }), () => this.runner.requestStop(id, commandId))
  }
  async stopNode(id: string, target: WorkflowStopTarget, commandId: string): Promise<boolean> {
    const generation = this.admissionGeneration
    const normalized = validateWorkflowStopTarget(target)
    await this.ensureReady()
    const preview = await this.loadPreview(id)
    const fingerprint = JSON.stringify({ workflowId: id, mode: 'node', target: normalized })
    return this.stopReceipt(commandId, fingerprint, () =>
      this.runner.requestStop(preview.workflowId, commandId, () => generation === this.admissionGeneration && !this.closed, normalized))
  }
  cancelPlanning(commandId: string): boolean {
    if (this.cancelled.size >= 256) this.cancelled.delete(this.cancelled.values().next().value!)
    this.cancelled.add(commandId)
    for (const entry of this.planning.values()) if (entry.commandId === commandId) entry.stop()
    return true
  }
  stopAll(): void { this.runner.stopAll(); for (const entry of this.planning.values()) entry.stop() }
  close(): void {
    this.closed = true
    this.admissionFrozen = true
    // Safe shutdown preparation owns durable stop admission. Do not bypass it
    // with a best-effort signal when the app begins irreversible teardown.
  }
  async snapshot(id: string): Promise<WorkflowProgress | undefined> {
    await this.ensureReady()
    const live = this.runner.snapshot(id)
    if (live) return this.progressSnapshot(live)
    const record = await this.options.store.load(id)
    return record && this.progressSnapshot(record.progress, record.stopRequests, record)
  }
  async list(workspace: string, cursor?: string): Promise<WorkflowProgressPage> {
    await this.ensureReady()
    const page = await this.options.store.listPage(cursor, 20)
    return { records: page.records.filter(record => record.preview.workspace === workspace)
      .map(record => {
        const live = this.runner.snapshot(record.preview.workflowId)
        return this.progressSnapshot(live ?? record.progress, live ? undefined : record.stopRequests, record)
      }),
      nextCursor: page.nextCursor, unresolvedPlanning: this.unresolvedPlanning }
  }
}
export type { WorkflowProviderExecutionResult }
