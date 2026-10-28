import { WORKFLOW_MAX_STOP_REQUESTS, type WorkflowProgress, type WorkflowStopProvenance } from '../shared/workflow'
import type { WorkflowStopTarget } from '../shared/workflow-api'
import { workflowControlCopy } from '../shared/constants/copy'
import { fenceWorkflowTargetStop, sameWorkflowStopProvenance, sameWorkflowStopTarget, validateWorkflowStopRequests, workflowStopTargetKey } from './workflow-stop'
import type { WorkflowRootExecutionState } from './workflow-runner-contracts'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'

type Context = {
  active: Map<string, WorkflowRootExecutionState>
  store: WorkflowStore
  now: () => number
  persist: (record: WorkflowStoreRecord, progress: WorkflowProgress) => Promise<void>
}

/** Durable stop delivery is kept separate from Runner execution so redelivery
 * can validate the receipt before any native signal is attempted. */
export async function requestWorkflowStop(context: Context, workflowId: string, commandId: string, canSignal?: () => boolean, target?: WorkflowStopTarget, provenance?: WorkflowStopProvenance): Promise<boolean> {
  const entry = context.active.get(workflowId)
  const record = entry?.record ?? await context.store.load(workflowId)
  if (!record) return false
  validateWorkflowStopRequests(record)
  const prior = record.stopRequests?.find(request => request.commandId === commandId)
  if (prior) {
    if (!sameWorkflowStopTarget(prior.target, target) || !sameWorkflowStopProvenance(prior.provenance, provenance)) throw new Error(workflowControlCopy.invalidStopReceipt)
    const durable = entry ? await context.store.load(workflowId) : record
    if (!durable?.stopRequests?.some(request => request.commandId === commandId && sameWorkflowStopTarget(request.target, target) && sameWorkflowStopProvenance(request.provenance, provenance))) throw new Error(workflowControlCopy.unconfirmedStopReceipt)
    return true
  }
  if (!entry) return false
  if (target) {
    const exists = target.kind === 'attempt' ? record.intents.some(intent => intent.workflowId === workflowId && intent.attemptId === target.id) : (record.systemIntents ?? []).some(intent => intent.stepId === target.id)
    const settled = target.kind === 'attempt' ? record.outcomes.find(outcome => outcome.attemptId === target.id)?.settled : (record.systemOutcomes ?? []).find(outcome => outcome.stepId === target.id)?.settled
    if (!exists || settled === true) return false
    fenceWorkflowTargetStop(entry, target)
  } else entry.halt()
  if (!await entry.initialized) {
    if (target) entry.targetLatches.delete(workflowStopTargetKey(target))
    return false
  }
  if ((entry.record.stopRequests?.length ?? 0) >= WORKFLOW_MAX_STOP_REQUESTS) throw new Error(workflowControlCopy.stopLimit)
  const requestedAt = context.now()
  if (!target) entry.progress.stopRequestedAt ??= requestedAt
  const requests = entry.record.stopRequests ??= []
  requests.push({ commandId, requestedAt, ...(target ? { target } : {}), ...(provenance ? { provenance } : {}) })
  await context.persist(entry.record, entry.progress)
  if (canSignal && !canSignal()) return true
  if (target) {
    const key = workflowStopTargetKey(target)
    entry.targetLatches.set(key, true)
    for (const stop of entry.targetStops.get(key) ?? []) stop()
  } else entry.stop()
  return true
}
