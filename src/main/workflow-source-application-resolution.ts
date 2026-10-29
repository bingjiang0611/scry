import { workflowChildBlocks, type WorkflowBlock } from '../shared/workflow'
import type { WorkflowFrozenCheck } from '../shared/workflow-check'
import type { WorkflowSourceApplicationTarget } from '../shared/workflow-source-application'
import type { WorkflowReplicaReceipt, WorkflowReplicaReference } from '../shared/workflow-replica'
import type { WorkflowSystemIntent, WorkflowSystemOutcome } from '../shared/workflow-system'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import type { WorkflowReplicas } from './workflow-replica'
import { validateWorkflowSystemLedger } from './workflow-system-ledger'
import { verifyWorkflowInputMaterialization } from './workflow-input-snapshot'
import { verifyWorkflowCheckValue } from './workflow-check-evidence'
import { governingWorkflowSystemPreview } from './workflow-revision-boundaries'
import { validateWorkflowFrozenCheck } from './workflow-check'

export type ResolvedWorkflowSourceApplication = Readonly<{
  record: WorkflowStoreRecord
  target: WorkflowSourceApplicationTarget
  sourceWorkspace: string
  candidate: WorkflowReplicaReference
  candidateReceipt: WorkflowReplicaReceipt
  checkedCandidateHash: string
  frozenCheck: WorkflowFrozenCheck
}>

function block(root: WorkflowBlock, nodeId: string): WorkflowBlock | undefined {
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()!
    if (current.blockId === nodeId) return current
    pending.push(...workflowChildBlocks(current))
  }
  return undefined
}

export class WorkflowSourceApplicationResolver {
  constructor(private readonly store: WorkflowStore, private readonly replicas: WorkflowReplicas) {}

  async targets(workflowId: string, programRevision: string): Promise<WorkflowSourceApplicationTarget[]> {
    const record = await this.record(workflowId, programRevision)
    const results: WorkflowSourceApplicationTarget[] = [], outcomes = record.systemOutcomes ?? []
    for (const intent of record.systemIntents ?? []) {
      if (intent.kind !== 'check') continue
      const outcome = outcomes.find(item => item.stepId === intent.stepId), check = outcome?.check, materialization = check?.inputs?.materialization
      if (!outcome || outcome.state !== 'completed' || !outcome.settled || !outcome.resultRef || check?.state !== 'passed' || !check.settled || check.truncated ||
        check.inputs?.changes.state !== 'available' || materialization?.state !== 'available' || !materialization.candidate) continue
      results.push({ workflowId: record.preview.workflowId, programRevision: record.preview.programRevision, workflowRevision: record.progress.revision ?? 0,
        stepId: intent.stepId, nodeId: intent.nodeId })
    }
    return results
  }

  async resolve(workflowId: string, programRevision: string, stepId: string): Promise<ResolvedWorkflowSourceApplication> {
    return this.resolveRecord(await this.record(workflowId, programRevision), stepId)
  }

  acquire(candidate: WorkflowReplicaReference): Promise<{ directory: string; release: () => void }> {
    return this.replicas.acquire(candidate)
  }

  private async record(workflowId: string, programRevision: string): Promise<WorkflowStoreRecord> {
    const record = await this.store.load(workflowId)
    if (!record || record.preview.programRevision !== programRevision) throw new Error('源码应用工作流或程序版本不可用')
    validateWorkflowSystemLedger(record)
    return record
  }

  private async resolveRecord(record: WorkflowStoreRecord, stepId: string): Promise<ResolvedWorkflowSourceApplication> {
    const intents = record.systemIntents ?? [], index = intents.findIndex(intent => intent.stepId === stepId)
    const intent: WorkflowSystemIntent | undefined = index < 0 ? undefined : intents[index]
    const outcome: WorkflowSystemOutcome | undefined = (record.systemOutcomes ?? []).find(item => item.stepId === stepId)
    if (!intent || intent.kind !== 'check' || intent.programRevision !== record.preview.programRevision || !outcome || outcome.state !== 'completed' || !outcome.settled || !outcome.check || !outcome.resultRef) throw new Error('源码应用检查记录不可用')
    const check = outcome.check, materialization = check.inputs?.materialization
    if (check.state !== 'passed' || !check.settled || check.truncated || check.inputs?.changes.state !== 'available' || materialization?.state !== 'available' || !materialization.candidate) throw new Error('源码应用候选未通过完整检查')
    await verifyWorkflowInputMaterialization(this.store, record, materialization)
    const preview = governingWorkflowSystemPreview(record, 'intent', index)
    const node = block(preview.program.body, intent.nodeId)
    if (node?.kind !== 'check' || !node.authorization) throw new Error('源码应用冻结检查不可用')
    const frozenCheck = validateWorkflowFrozenCheck(node.authorization)
    const raw = await this.store.loadValue(record.preview.workflowId, outcome.resultRef)
    if (raw.state !== 'known') throw new Error('源码应用检查结果不可用')
    await verifyWorkflowCheckValue(this.store, record.preview.workflowId, intent.stepId, check, frozenCheck, raw.value)
    const [candidateReceipt, materializedReceipt] = await Promise.all([
      this.replicas.resolve(materialization.candidate), this.replicas.resolve(materialization.materialized)
    ])
    this.replicas.assertSource(materializedReceipt, materialization.candidate)
    return { record, sourceWorkspace: record.preview.workspace, candidate: materialization.candidate, candidateReceipt,
      checkedCandidateHash: materialization.materialized.inputHash, frozenCheck,
      target: { workflowId: record.preview.workflowId, programRevision: record.preview.programRevision, workflowRevision: record.progress.revision ?? 0, stepId, nodeId: intent.nodeId } }
  }
}
