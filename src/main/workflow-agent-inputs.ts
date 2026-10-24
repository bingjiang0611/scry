import type { WorkflowValueReference } from '../shared/workflow'
import { workflowAgentSource } from './workflow-agent-source'
import { workflowSystemArtifactKey } from './workflow-system-ledger'
import type { WorkflowInputSnapshot } from '../shared/workflow-system'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import { captureWorkflowInputs, saveWorkflowInputSnapshot, verifyWorkflowInputSnapshot } from './workflow-input-snapshot'
import type { WorkflowStore } from './workflow-store'

export type WorkflowAgentInputObservation = { state: 'available'; snapshot: WorkflowInputSnapshot; sourceRef?: WorkflowValueReference } | { state: 'unavailable'; reason: string }
export type WorkflowAgentInputs = { before: WorkflowAgentInputObservation; after?: WorkflowAgentInputObservation }

/** Additional observation, never an execution grant. Scanner limits and unsupported
 * filesystem entries make reuse unavailable without changing Provider admission. */
export async function observeWorkflowAgentInputs(store: WorkflowStore, workflowId: string, attemptId: string, workspace: string, phase: 'before' | 'after', environment: () => NodeJS.ProcessEnv): Promise<WorkflowAgentInputObservation> {
  try {
    const captured = await captureWorkflowInputs(workspace, () => false)
    const source = await workflowAgentSource(workspace, environment)
    captured.info.finishedAt = Date.now()
    // Bind repository metadata into this phase's manifest header. A second
    // per-phase source file adds no authority and needlessly duplicates fsyncs.
    return { state: 'available', snapshot: await saveWorkflowInputSnapshot(store, workflowId, attemptId, phase, captured, source) }
  } catch (error) {
    return { state: 'unavailable', reason: `${copy.inputsUnavailable}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4096) }
  }
}

export async function reusableWorkflowAgentInputs(store: WorkflowStore, workflowId: string, attemptId: string, inputs: WorkflowAgentInputs | undefined, current: WorkflowAgentInputObservation | undefined): Promise<boolean> {
  if (inputs?.before.state !== 'available' || inputs.after?.state !== 'available' || current?.state !== 'available') return false
  await verifyWorkflowInputSnapshot(store, workflowId, attemptId, 'before', inputs.before.snapshot)
  await verifyWorkflowInputSnapshot(store, workflowId, attemptId, 'after', inputs.after.snapshot)
  const sources: string[] = []
  for (const [phase, observation] of [['before', inputs.before], ['after', inputs.after], ['before', current]] as const) {
    let source: unknown = observation.snapshot.repositorySource
    if (observation.sourceRef) {
      // Existing committed records used a separate attempt/phase-bound file.
      // Keep reading that evidence; never invent a source for a legacy record.
      if (source !== undefined || observation.sourceRef.key !== workflowSystemArtifactKey(attemptId, 'agent-source-' + phase)) throw new Error(copy.invalid)
      const value = await store.loadValue(workflowId, observation.sourceRef)
      if (value.state !== 'known') throw new Error(copy.invalid)
      source = value.value
    }
    if (!source || typeof source !== 'object' || !('kind' in source) ||
      (source.kind !== 'non_repository' && (source.kind !== 'repository' || !('root' in source) || typeof source.root !== 'string' || !('head' in source) || typeof source.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(source.head)))) throw new Error(copy.invalid)
    sources.push(JSON.stringify(source))
  }
  return inputs.before.snapshot.inputHash === inputs.after.snapshot.inputHash && inputs.after.snapshot.inputHash === current.snapshot.inputHash &&
    sources[0] === sources[1] && sources[1] === sources[2]
}
