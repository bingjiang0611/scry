import type { WorkflowExecutionInspectionRecord } from '@shared/workflow-inspection'
import type { WorkflowFrameInspection } from '@shared/workflow-api'
import type { WorkflowUsage } from '@shared/workflow-usage'
import { WORKFLOW_INSPECTION_COPY as copy } from './constants/workflow-inspection-copy'

export type AvailableWorkflowFrame = Extract<WorkflowFrameInspection, { state: 'available' }>
export type WorkflowGraphItem = Readonly<{
  kind: 'instance'
  id: string
  nodeId?: string
  category: 'turn' | 'candidate' | 'evidence' | 'control' | 'classifier'
  state: string
  settled?: boolean
  frameId?: string
  parentFrameId?: string
  branch?: string
  retryOf?: string
  retryCommand?: string
  usage: 'unavailable' | WorkflowUsage
}>

function category(record: WorkflowExecutionInspectionRecord): WorkflowGraphItem['category'] {
  if ('attemptId' in record) return 'turn'
  if ('classifierId' in record) return 'classifier'
  const kind = record.intent.state === 'available' ? record.intent.value.kind : undefined
  return kind === 'prepare_replica' || kind === 'combine' ? 'candidate' : 'evidence'
}

export function workflowGraphItems(records: readonly WorkflowExecutionInspectionRecord[], frames: ReadonlyMap<string, AvailableWorkflowFrame>, usage: ReadonlyMap<string, WorkflowUsage> = new Map()): WorkflowGraphItem[] {
  // Main has no bounded control-frame enumeration. Retain only canonical
  // frame references belonging to recorded effects; never invent control runs.
  return records.map(record => {
    const intent = record.intent.state === 'available' ? record.intent.value : undefined
    const attempt = 'attemptId' in record && record.intent.state === 'available' ? record.intent.value : undefined
    const id = 'attemptId' in record ? record.attemptId : 'classifierId' in record ? record.classifierId : record.stepId
    const nodeId = intent?.nodeId ?? ('attemptId' in record && record.outcome.state === 'available' ? record.outcome.value.nodeId : undefined)
    const frameId = intent?.frame.state === 'available' ? intent.frame.frameId : undefined
    const frame = frameId ? frames.get(frameId) : undefined
    const outcome = record.outcome.state === 'available' ? record.outcome.value : undefined
    return {
      kind: 'instance', id, ...(nodeId ? { nodeId } : {}), category: category(record),
      state: outcome?.state ?? copy.missingOutcome, ...(outcome ? { settled: outcome.settled } : {}),
      ...(frameId ? { frameId } : {}),
      ...(frame?.frame.parentage.state === 'available' ? { parentFrameId: frame.frame.parentage.frameId } : {}),
      ...(frame?.frame.arm ? { branch: frame.frame.arm } : {}),
      ...(attempt?.previousAttemptId ? { retryOf: attempt.previousAttemptId } : {}),
      ...(attempt?.retryCommandId ? { retryCommand: attempt.retryCommandId } : {}),
      usage: usage.get(id) ?? 'unavailable'
    }
  })
}
