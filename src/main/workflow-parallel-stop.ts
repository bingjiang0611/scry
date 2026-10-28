import { WORKFLOW_MAX_STOP_REQUESTS } from '../shared/workflow'
import { workflowControlCopy } from '../shared/constants/copy'
import type { WorkflowStopTarget } from '../shared/workflow-api'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import { fenceWorkflowTargetStop, sameWorkflowStopProvenance, sameWorkflowStopTarget, validateWorkflowStopRequests, workflowStopTargetKey } from './workflow-stop'
import type { WorkflowRootExecutionState } from './workflow-runner-contracts'
import { workflowParallelFailureCommandId, workflowParallelFailureProvenance, type WorkflowParallelFailure } from './workflow-parallel-policy'

/** A policy decision uses the existing control ledger. Its scope-only receipt
 * records the fence even when no child has reached effect admission. It is not
 * a root stop and cannot authorize a physical signal by itself. */
export async function recordWorkflowParallelFailure(options: {
  owner: Pick<WorkflowRootExecutionState, 'record' | 'targetLatches' | 'targetStops'>
  failure: WorkflowParallelFailure
  store: Pick<WorkflowStore, 'load' | 'loadFrame'>
  now: () => number
  persist: () => Promise<void>
  canSignal: () => boolean
}): Promise<boolean> {
  const { owner, failure, store } = options
  const record = owner.record
  const workflowId = record.preview.workflowId
  validateWorkflowStopRequests(record)
  const frame = await store.loadFrame(workflowId, failure.trigger.frameId)
  if (!frame || frame.programRevision !== record.preview.programRevision || frame.executionEpoch !== record.execution?.epoch) throw new Error(workflowControlCopy.invalidStopReceipt)
  const provenance = workflowParallelFailureProvenance(failure.trigger)
  const commandId = workflowParallelFailureCommandId(workflowId, failure.trigger)
  const requests = record.stopRequests ??= []
  const prior = requests.find(request => request.commandId === commandId)
  if (prior) {
    if (prior.target || !sameWorkflowStopProvenance(prior.provenance, provenance)) throw new Error(workflowControlCopy.invalidStopReceipt)
    const durable = await store.load(workflowId)
    if (!durable?.stopRequests?.some(request => request.commandId === commandId && !request.target && sameWorkflowStopProvenance(request.provenance, provenance))) throw new Error(workflowControlCopy.unconfirmedStopReceipt)
    // Readback acknowledges the journal, not an unknown previous signal.
    return true
  }
  const requestedAt = options.now()
  const additions: NonNullable<WorkflowStoreRecord['stopRequests']> = [{ commandId, requestedAt, provenance }]
  const signalTargets: WorkflowStopTarget[] = []
  for (const target of failure.admission.targets) {
    const exists = target.kind === 'attempt'
      ? record.intents.some(intent => intent.workflowId === workflowId && intent.attemptId === target.id)
      : record.systemIntents?.some(intent => intent.stepId === target.id)
    const settled = target.kind === 'attempt'
      ? record.outcomes.find(outcome => outcome.attemptId === target.id)?.settled
      : record.systemOutcomes?.find(outcome => outcome.stepId === target.id)?.settled
    if (!exists || settled === true) continue
    additions.push({ commandId: workflowParallelFailureCommandId(workflowId, failure.trigger, target), requestedAt, target, provenance })
    // Another control receipt may already have an unknown dispatch. A new
    // automatic decision must not replay it; explicit user stop-again remains
    // the existing, separately journalled operation.
    if (!requests.some(request => sameWorkflowStopTarget(request.target, target))) signalTargets.push(target)
  }
  if (requests.length + additions.length > WORKFLOW_MAX_STOP_REQUESTS) throw new Error(workflowControlCopy.stopLimit)
  for (const request of additions) {
    if (request.target) fenceWorkflowTargetStop(owner, request.target)
    requests.push(request)
  }
  await options.persist()
  if (!options.canSignal()) return true
  for (const target of signalTargets) {
    const key = workflowStopTargetKey(target)
    if (owner.targetLatches.get(key) === true) continue
    owner.targetLatches.set(key, true)
    for (const stop of owner.targetStops.get(key) ?? []) stop()
  }
  return true
}
