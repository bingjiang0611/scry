import type { WorkflowControlFrame } from '../shared/workflow'
import type { WorkflowExecutionInspectionRecord } from '../shared/workflow-inspection'
import type { WorkflowClassifierOutcome } from '../shared/workflow-classifier'
import type { WorkflowSourceApplicationReceipt } from '../shared/workflow-source-application'

export type WorkflowGraphNode = Readonly<{
  id: string
  kind: 'control' | 'attempt' | 'system' | 'classifier' | 'application'
  nodeId?: string
  frameId?: string
  parentFrameId?: string | null
  state: string
  settled?: boolean
  provenance: 'canonical_ledger' | 'canonical_frame' | 'unavailable'
}>

/** Graph projection keeps pure control frames distinct from effects. Optional
 * classifier/application rows are supplied by their own Main-owned ledgers. */
export function projectWorkflowGraph(
  records: readonly WorkflowExecutionInspectionRecord[],
  _frames: readonly WorkflowControlFrame[],
  classifierOutcomes: readonly WorkflowClassifierOutcome[] = [],
  applicationReceipts: readonly WorkflowSourceApplicationReceipt[] = []
): WorkflowGraphNode[] {
  // Standalone control frames are not listed by a bounded Main ledger API, so
  // they are intentionally not projected. Effect rows may still carry a frame
  // reference because that reference is part of their canonical ledger record.
  const result: WorkflowGraphNode[] = []
  for (const record of records) {
    const isAttempt = 'attemptId' in record, isClassifier = 'classifierId' in record
    const id = isAttempt ? record.attemptId : isClassifier ? record.classifierId : record.stepId
    const intent = record.intent.state === 'available' ? record.intent.value : undefined
    const outcome = record.outcome.state === 'available' ? record.outcome.value : undefined
    const frameId = intent?.frame.state === 'available' ? intent.frame.frameId : undefined
    result.push({ id, kind: isAttempt ? 'attempt' : isClassifier ? 'classifier' : 'system', ...(intent && 'nodeId' in intent ? { nodeId: intent.nodeId } : {}), ...(frameId ? { frameId } : {}),
      state: outcome?.state ?? 'unknown', ...(outcome ? { settled: outcome.settled } : {}), provenance: 'canonical_ledger' })
  }
  for (const outcome of classifierOutcomes) result.push({ id: outcome.classifierId, kind: 'classifier', state: outcome.state, settled: outcome.settled, provenance: 'canonical_ledger' })
  for (const receipt of applicationReceipts) result.push({ id: receipt.operationId, kind: 'application', state: receipt.state, settled: receipt.state !== 'unknown', provenance: 'canonical_ledger' })
  return result
}
