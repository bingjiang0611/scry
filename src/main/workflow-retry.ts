import { WORKFLOW_MAX_ATTEMPTS, WORKFLOW_MAX_TASK_ATTEMPTS, workflowChildBlocks, type WorkflowAttemptOutcome } from '../shared/workflow'
import type { WorkflowRetryTarget } from '../shared/workflow-api'
import { workflowRecoveryCopy, workflowRetryCopy as copy } from '../shared/constants/copy'
import type { WorkflowExecutionOwnership, WorkflowIntent, WorkflowStoreRecord } from './workflow-store'

type Segment = WorkflowExecutionOwnership['segments'][number]
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)

export function validateWorkflowRetryTarget(value: unknown): WorkflowRetryTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(copy.target)
  const target = value as Record<string, unknown>
  const keys = Object.keys(target)
  if (keys.length !== 3 || keys.some(key => !['taskId', 'attemptId', 'expectedRevision'].includes(key))) throw new Error(copy.target)
  if (typeof target.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,96}:[a-f0-9]{64}:[A-Za-z0-9_-]{1,96}$/.test(target.taskId) ||
    !id(target.attemptId) || !Number.isSafeInteger(target.expectedRevision) || (target.expectedRevision as number) < 1) throw new Error(copy.target)
  return { taskId: target.taskId, attemptId: target.attemptId, expectedRevision: target.expectedRevision as number }
}

function replayEligible(outcome: WorkflowAttemptOutcome | undefined): boolean {
  // Minted only by the canonical pre-Provider dispatch guard. A failed result,
  // native close, absent tool list or owner death alone is not replay evidence.
  return outcome?.state === 'failed' && outcome.settled && outcome.providerDispatch === 'not_attempted'
}

export function workflowRetryBoundary(record: WorkflowStoreRecord, taskId: string): number {
  const segments = record.execution?.segments ?? []
  for (let index = segments.length - 1; index >= 0; index--) if (segments[index].retry?.taskId === taskId) return index
  return 0
}

export function workflowPendingRetry(record: WorkflowStoreRecord, taskId: string): Segment | undefined {
  const segment = record.execution?.segments[workflowRetryBoundary(record, taskId)]
  return segment?.retry?.taskId === taskId && !record.intents.some(intent => intent.retryCommandId === segment.commandId) ? segment : undefined
}

/** Validates append-only successor chains, not a latest-by-array-order guess. */
export function validateWorkflowAttemptChains(record: WorkflowStoreRecord): void {
  const latest = new Map<string, WorkflowIntent>(), counts = new Map<string, number>(), consumed = new Set<string>()
  const outcomes = new Map(record.outcomes.map(outcome => [outcome.attemptId, outcome]))
  const retries = new Map(record.execution?.segments.filter(segment => segment.mode === 'retry').map(segment => [segment.commandId, segment]))
  for (const intent of record.intents) {
    const previous = latest.get(intent.taskId), count = (counts.get(intent.taskId) ?? 0) + 1
    if (count > WORKFLOW_MAX_TASK_ATTEMPTS) throw new Error(workflowRecoveryCopy.ledger)
    if (previous) {
      const retry = retries.get(intent.retryCommandId)
      if (intent.previousAttemptId !== previous.attemptId || !retry?.retry || retry.retry.taskId !== intent.taskId || retry.retry.attemptId !== previous.attemptId || consumed.has(intent.retryCommandId!) || !replayEligible(outcomes.get(previous.attemptId))) throw new Error(workflowRecoveryCopy.ledger)
      consumed.add(intent.retryCommandId!)
    } else if (intent.previousAttemptId !== undefined || intent.retryCommandId !== undefined) throw new Error(workflowRecoveryCopy.ledger)
    latest.set(intent.taskId, intent)
    counts.set(intent.taskId, count)
  }
  const selected = new Set<string>()
  for (const segment of retries.values()) {
    const target = segment.retry!, previous = record.intents.find(intent => intent.attemptId === target.attemptId)
    if (!previous || previous.taskId !== target.taskId || !replayEligible(outcomes.get(target.attemptId)) || selected.has(target.attemptId)) throw new Error(workflowRecoveryCopy.ledger)
    selected.add(target.attemptId)
  }
  const taskOutcomes = new Map<string, boolean>()
  for (const outcome of record.outcomes) {
    const admitted = record.intents.some(intent => intent.attemptId === outcome.attemptId)
    const previous = taskOutcomes.get(outcome.taskId)
    if (previous !== undefined && (!previous || !admitted)) throw new Error(workflowRecoveryCopy.ledger)
    taskOutcomes.set(outcome.taskId, admitted)
  }
}

/** Caller separately proves ownership/settlement before checking this policy. */
export function assertWorkflowRetryTarget(record: WorkflowStoreRecord, target: WorkflowRetryTarget): void {
  validateWorkflowRetryTarget(target)
  if (record.progress.revision !== target.expectedRevision) throw new Error(copy.stale)
  if (record.progress.state !== 'failed' && record.progress.state !== 'blocked') throw new Error(copy.state)
  // Static scopes keep task identity stable and cannot have a successful
  // downstream consumer of this absent output. Dynamic cache invalidation and
  // loop replay require a separate, explicit dependency/replay contract.
  const blocks = [record.preview.program.body]
  while (blocks.length) {
    const block = blocks.pop()!
    if (!['sequence', 'parallel', 'call', 'bind', 'return'].includes(block.kind)) throw new Error(copy.dynamic)
    blocks.push(...workflowChildBlocks(block))
  }
  const outcome = [...record.outcomes].reverse().find(value => value.taskId === target.taskId)
  const intent = [...record.intents].reverse().find(value => value.taskId === target.taskId)
  if (outcome?.attemptId !== target.attemptId || intent?.attemptId !== target.attemptId) throw new Error(copy.stale)
  if (!replayEligible(outcome)) throw new Error(copy.unsafe)
  if (record.execution?.segments.some(segment => segment.retry && workflowPendingRetry(record, segment.retry.taskId)?.id === segment.id)) throw new Error(copy.pending)
  if (record.intents.filter(value => value.taskId === target.taskId).length >= WORKFLOW_MAX_TASK_ATTEMPTS) throw new Error(copy.limit)
  if (record.progress.dispatchAttempts >= WORKFLOW_MAX_ATTEMPTS) throw new Error(workflowRecoveryCopy.limit)
}

export function workflowRetryAdmission(record: WorkflowStoreRecord, taskId: string): Pick<WorkflowIntent, 'previousAttemptId' | 'retryCommandId'> {
  const previous = record.intents.filter(intent => intent.taskId === taskId)
  if (!previous.length) return {}
  const retry = workflowPendingRetry(record, taskId)
  if (!retry?.retry || previous.at(-1)!.attemptId !== retry.retry.attemptId || !replayEligible(record.outcomes.find(outcome => outcome.attemptId === retry.retry!.attemptId))) throw new Error(workflowRecoveryCopy.ledger)
  if (previous.length >= WORKFLOW_MAX_TASK_ATTEMPTS) throw new Error(copy.limit)
  return { previousAttemptId: retry.retry.attemptId, retryCommandId: retry.commandId! }
}
