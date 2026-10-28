import { randomUUID } from 'node:crypto'
import type { WorkflowBlock, WorkflowControlFrame, WorkflowEvaluation, WorkflowPlanPreview } from '../shared/workflow'
import { workflowFrameCopy, workflowRecoveryCopy } from '../shared/constants/copy'
import { workflowRevisionCopy } from '../shared/constants/workflow-revision-copy'
import type { WorkflowControl, WorkflowControlScope } from './workflow-control'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import type { WorkflowRunnerEffects } from './workflow-runner-effects'
import { assertWorkflowRevisionReuseInputs } from './workflow-revision-reuse'
import { reusableWorkflowAgentInputs } from './workflow-agent-inputs'
import { decodeWorkflowOutput } from './workflow-values'

/** One effect callback for the canonical Interpreter. Historical selections are
 * committed on the current frame before any original result is exposed. */
export async function runWorkflowCall(effects: WorkflowRunnerEffects, store: WorkflowStore, preview: WorkflowPlanPreview, control: WorkflowControl,
  record: WorkflowStoreRecord, controller: { stopped: boolean }, activeStops: Set<() => boolean>,
  block: Extract<WorkflowBlock, { kind: 'call' }>, scope: WorkflowControlScope, frame?: WorkflowControlFrame) {
  const staticReuse = record.revisions?.at(-1)?.reuse.some(entry => entry.nodeId === block.blockId)
  let recovered = frame?.callReuse ? await control.selectedCall(frame) : control.recoveredOutcome(block, scope, frame)
  const dynamicSelection = frame?.callInputRef && (record.revisions?.length ?? 0) > 1 && (!recovered || frame.callReuse)
  if (!controller.stopped && !scope.admission?.isStopped() && (staticReuse || dynamicSelection)) {
    const role = preview.program.roles.find(candidate => candidate.role === block.role)!
    await effects.options.beforeDispatch?.(role, preview.workspace)
  }
  if (staticReuse) await assertWorkflowRevisionReuseInputs(store, effects.options.systems, record, block.blockId)
  if (frame && dynamicSelection) {
    if (frame.callReuse) {
      const current = await effects.options.systems?.observeAgentInputs(preview.workflowId, randomUUID(), preview.workspace, 'before')
      if (!await reusableWorkflowAgentInputs(store, preview.workflowId, frame.callReuse.attemptId, record.agentInputs?.[frame.callReuse.attemptId], current)) throw new Error(workflowRevisionCopy.sourceChanged)
    } else if (!controller.stopped && !scope.admission?.isStopped()) {
      recovered = await control.selectCall(frame, async () => effects.options.systems?.observeAgentInputs(preview.workflowId, randomUUID(), preview.workspace, 'before'))
    }
  }
  if (recovered && block.replica) {
    const input = await control.evaluate(block.replica, scope, block.blockId, () => controller.stopped || Boolean(scope.admission?.isStopped()))
    const intent = record.intents.find(value => value.attemptId === recovered.attemptId)
    if (JSON.stringify(intent?.replica) !== JSON.stringify(input.state === 'known' ? input.replica : undefined)) throw new Error(workflowRecoveryCopy.frame)
  }
  const outcome = recovered ?? await effects.dispatch(preview, block, record, controller, activeStops, scope, control, frame)
  const output = recovered ? await store.loadOutput(preview.workflowId, outcome) : outcome.output
  let value: WorkflowEvaluation = { state: 'unknown', reason: outcome.error ?? workflowFrameCopy.failedValue, derivedFrom: ['attempt:' + outcome.attemptId] }
  if (outcome.state === 'completed' && outcome.settled && output !== undefined) {
    const key = preview.workflowId + ':' + preview.programRevision + ':' + outcome.attemptId
    const data = block.outputSchema ? effects.structuredOutputs.get(key) ?? decodeWorkflowOutput(output, block.outputSchema) : output
    value = { state: 'known', value: data, derivedFrom: ['attempt:' + outcome.attemptId] }
  }
  return { outcome, value }
}
