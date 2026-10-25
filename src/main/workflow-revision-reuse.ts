import type { WorkflowPlanPreview } from '../shared/workflow'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import { workflowFrameId } from './workflow-frames'
import { decodeWorkflowOutput } from './workflow-values'
import { reusableWorkflowAgentInputs } from './workflow-agent-inputs'
import { workflowStaticRevisionNodes, workflowRevisionTaskId, type WorkflowRevisionReuse } from './workflow-revisions'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import type { WorkflowSystemHost } from './workflow-system-host'
import { randomUUID } from 'node:crypto'
import { workflowHasDynamicRevision } from './workflow-call-semantics'

/** Only main-issued frames + canonical outcomes authorize reuse. A descriptor,
 * model result or derivedFrom string by itself never becomes a reusable fact. */
export async function prepareWorkflowRevisionReuse(store: WorkflowStore, record: WorkflowStoreRecord, preview: WorkflowPlanPreview, host: WorkflowSystemHost | undefined, commandId: string): Promise<WorkflowRevisionReuse[]> {
  // Dynamic invocations are selected by actual frame input/context at reach
  // time. Frozen governing arrays are never populated lazily by nodeId.
  if (workflowHasDynamicRevision(record.preview) || workflowHasDynamicRevision(preview)) return []
  const current = await host?.observeAgentInputs(preview.workflowId, commandId, preview.workspace, 'before')
  const old = workflowStaticRevisionNodes(record.preview), next = workflowStaticRevisionNodes(preview)
  const selected = new Map<string, WorkflowRevisionReuse>(), checked = new Map<string, boolean>()
  const check = async (nodeId: string): Promise<boolean> => {
    if (checked.has(nodeId)) return checked.get(nodeId)!
    const node = next.nodes.get(nodeId)!
    checked.set(nodeId, false)
    if (old.fingerprints.get(nodeId) !== next.fingerprints.get(nodeId)) return false
    if (node.block.kind === 'replica' || node.block.kind === 'check' || node.block.kind === 'verification' || (node.block.kind === 'call' && node.block.replica)) return false
    for (const dependency of node.dependencies) if (!await check(dependency)) return false
    if (node.block.kind !== 'call') { checked.set(nodeId, true); return true }
    const previousNode = old.nodes.get(nodeId)!
    const taskId = workflowRevisionTaskId(record.preview, nodeId, previousNode.path)
    const inherited = record.revisions?.at(-1)?.reuse.find(entry => entry.nodeId === nodeId)
    const outcome = [...record.outcomes].reverse().find(value => value.taskId === taskId) ?? (inherited ? record.outcomes.find(value => value.attemptId === inherited.attemptId) : undefined)
    const intent = outcome && record.intents.find(value => value.attemptId === outcome.attemptId)
    if (!outcome || !intent || outcome.state !== 'completed' || !outcome.settled || outcome.actualModelStatus !== 'observed' || (intent.requestedModel && outcome.actualModel !== intent.requestedModel)) return false
    // Requested runtime is frozen in the semantic fingerprint. Reuse also needs
    // an observed actual model; absent evidence cannot be promoted to equality.
    if (!await reusableWorkflowAgentInputs(store, preview.workflowId, outcome.attemptId, record.agentInputs?.[outcome.attemptId], current)) return false
    let frame = inherited ? await store.loadFrame(preview.workflowId, inherited.reference.frameId) : undefined
    if (!frame) for (const segment of [...record.execution!.segments].reverse()) {
      const candidate = await store.loadFrame(preview.workflowId, workflowFrameId(nodeId, previousNode.path, segment.generationId))
      if (candidate?.phase === 'completed' && candidate.resultRef) { frame = candidate; break }
    }
    if (!frame || frame.phase !== 'completed' || !frame.resultRef || frame.nodeId !== nodeId) throw new Error(copy.invalid)
    const value = await store.loadValue(preview.workflowId, frame.resultRef)
    const output = await store.loadOutput(preview.workflowId, outcome)
    if (output === undefined || value.state !== 'known' || JSON.stringify(value.derivedFrom) !== JSON.stringify(['attempt:' + outcome.attemptId]) ||
      JSON.stringify(value.value) !== JSON.stringify(node.block.outputSchema ? decodeWorkflowOutput(output, node.block.outputSchema) : output)) throw new Error(copy.invalid)
    selected.set(nodeId, { nodeId, attemptId: outcome.attemptId, reference: { frameId: frame.frameId, revision: frame.revision, resultRef: frame.resultRef } })
    checked.set(nodeId, true)
    return true
  }
  for (const [nodeId, node] of next.nodes) if (node.block.kind === 'call') await check(nodeId)
  return [...selected.values()]
}

export async function assertWorkflowRevisionReuseInputs(store: WorkflowStore, host: WorkflowSystemHost | undefined, record: WorkflowStoreRecord, nodeId: string): Promise<void> {
  const reuse = record.revisions?.at(-1)?.reuse.find(entry => entry.nodeId === nodeId)
  if (!reuse) return
  // Recheck at consumption, not just preview/claim. A newly executed sibling
  // may have changed the ambient workspace since revision admission.
  const observation = await host?.observeAgentInputs(record.preview.workflowId, randomUUID(), record.preview.workspace, 'before')
  if (!await reusableWorkflowAgentInputs(store, record.preview.workflowId, reuse.attemptId, record.agentInputs?.[reuse.attemptId], observation)) throw new Error(copy.sourceChanged)
}
