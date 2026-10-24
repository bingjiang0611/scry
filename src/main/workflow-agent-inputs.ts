import type { WorkflowValueReference } from '../shared/workflow'
import { workflowAgentSource } from './workflow-agent-source'
import { workflowSystemArtifactKey } from './workflow-system-ledger'
import type { WorkflowInputSnapshot } from '../shared/workflow-system'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import { captureWorkflowInputs, saveWorkflowInputSnapshot, verifyWorkflowInputSnapshot } from './workflow-input-snapshot'
import type { WorkflowStore } from './workflow-store'

export type WorkflowAgentInputObservation = { state: 'available'; snapshot: WorkflowInputSnapshot; sourceRef: WorkflowValueReference } | { state: 'unavailable'; reason: string }
export type WorkflowAgentInputs = { before: WorkflowAgentInputObservation; after?: WorkflowAgentInputObservation }

/** Additional observation, never an execution grant. Scanner limits and unsupported
 * filesystem entries make reuse unavailable without changing Provider admission. */
export async function observeWorkflowAgentInputs(store: WorkflowStore, workflowId: string, attemptId: string, workspace: string, phase: 'before' | 'after', environment: () => NodeJS.ProcessEnv): Promise<WorkflowAgentInputObservation> {
  try {
    const captured = await captureWorkflowInputs(workspace, () => false)
    const source = await workflowAgentSource(workspace, environment)
    const sourceRef = await store.saveValue(workflowId, workflowSystemArtifactKey(attemptId, 'agent-source-' + phase), { state: 'known', value: source, derivedFrom: [] })
    return { state: 'available', snapshot: await saveWorkflowInputSnapshot(store, workflowId, attemptId, phase, captured), sourceRef }
  } catch (error) {
    return { state: 'unavailable', reason: `${copy.inputsUnavailable}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4096) }
  }
}

export async function reusableWorkflowAgentInputs(store: WorkflowStore, workflowId: string, attemptId: string, inputs: WorkflowAgentInputs | undefined, current: WorkflowAgentInputObservation | undefined): Promise<boolean> {
  if (inputs?.before.state !== 'available' || inputs.after?.state !== 'available' || current?.state !== 'available') return false
  await verifyWorkflowInputSnapshot(store, workflowId, attemptId, 'before', inputs.before.snapshot)
  await verifyWorkflowInputSnapshot(store, workflowId, attemptId, 'after', inputs.after.snapshot)
  for (const [phase, observation] of [['before', inputs.before], ['after', inputs.after]] as const) {
    if (observation.sourceRef?.key !== workflowSystemArtifactKey(attemptId, 'agent-source-' + phase)) throw new Error(copy.invalid)
    await store.loadValue(workflowId, observation.sourceRef)
  }
  return inputs.before.snapshot.inputHash === inputs.after.snapshot.inputHash && inputs.after.snapshot.inputHash === current.snapshot.inputHash &&
    inputs.before.sourceRef.hash === inputs.after.sourceRef.hash && inputs.after.sourceRef.hash === current.sourceRef.hash
}
