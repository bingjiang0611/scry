import { WORKFLOW_MAX_ATTEMPTS, WORKFLOW_MAX_TASK_ATTEMPTS, workflowChildBlocks, type WorkflowAttemptOutcome } from '../shared/workflow'
import type { WorkflowRestartTarget, WorkflowRetryTarget } from '../shared/workflow-api'
import { workflowRecoveryCopy, workflowRetryCopy as copy } from '../shared/constants/copy'
import type { WorkflowExecutionOwnership, WorkflowIntent, WorkflowStoreRecord } from './workflow-store'

type Segment = WorkflowExecutionOwnership['segments'][number]
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)
const task = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}:[a-f0-9]{64}:[A-Za-z0-9_-]{1,96}$/.test(value)

function validateTarget(value: unknown): { taskId: string; attemptId: string; expectedRevision: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(copy.target)
  const target = value as Record<string, unknown>
  const keys = Object.keys(target)
  if (keys.length !== 3 || keys.some(key => !['taskId', 'attemptId', 'expectedRevision'].includes(key)) ||
    !task(target.taskId) || !id(target.attemptId) || !Number.isSafeInteger(target.expectedRevision) || (target.expectedRevision as number) < 1) throw new Error(copy.target)
  return { taskId: target.taskId, attemptId: target.attemptId, expectedRevision: target.expectedRevision as number }
}

export function validateWorkflowRetryTarget(value: unknown): WorkflowRetryTarget { return validateTarget(value) }
export function validateWorkflowRestartTarget(value: unknown): WorkflowRestartTarget { return validateTarget(value) }

function replayEligible(outcome: WorkflowAttemptOutcome | undefined): boolean {
  return outcome?.state === 'failed' && outcome.settled && outcome.providerDispatch === 'not_attempted'
}

export function workflowRetryBoundary(record: WorkflowStoreRecord, taskId: string): number {
  const segments = record.execution?.segments ?? []
  for (let index = segments.length - 1; index >= 0; index--) if (segments[index].retry?.taskId === taskId) return index
  return 0
}

export function workflowPendingRestart(record: WorkflowStoreRecord, taskId: string): Segment | undefined {
  const segments = record.execution?.segments ?? []
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index]
    if (segment.mode === 'restart' && segment.restart?.taskId === taskId && !record.intents.some(intent => intent.restartCommandId === segment.commandId)) return segment
  }
  return undefined
}

export function workflowPendingRetry(record: WorkflowStoreRecord, taskId: string): Segment | undefined {
  const segment = record.execution?.segments[workflowRetryBoundary(record, taskId)]
  return segment?.retry?.taskId === taskId && !record.intents.some(intent => intent.retryCommandId === segment.commandId) ? segment : undefined
}

function linkFor(segment: Segment, intent: WorkflowIntent, previous: WorkflowIntent, outcomes: Map<string, WorkflowAttemptOutcome>): boolean {
  if (segment.mode === 'retry') return Boolean(segment.retry && segment.retry.taskId === intent.taskId && segment.retry.attemptId === previous.attemptId && replayEligible(outcomes.get(previous.attemptId)))
  return Boolean(segment.mode === 'restart' && segment.restart && segment.restart.taskId === intent.taskId && segment.restart.attemptId === previous.attemptId && outcomes.get(previous.attemptId)?.state === 'unknown' && outcomes.get(previous.attemptId)?.settled && ['stalled', 'reply_lost'].includes(segment.restart.reason))
}

/** Validates append-only successor chains and exact one-to-one command links. */
export function validateWorkflowAttemptChains(record: WorkflowStoreRecord): void {
  const outcomes = new Map(record.outcomes.map(outcome => [outcome.attemptId, outcome]))
  const segments = new Map((record.execution?.segments ?? []).slice(1).map(segment => [segment.commandId, segment]))
  const linked = new Set<string>(), latest = new Map<string, WorkflowIntent>(), counts = new Map<string, number>()
  for (const intent of record.intents) {
    const previous = latest.get(intent.taskId), count = (counts.get(intent.taskId) ?? 0) + 1
    if (count > WORKFLOW_MAX_TASK_ATTEMPTS) throw new Error(workflowRecoveryCopy.ledger)
    const links = [intent.retryCommandId, intent.restartCommandId].filter((value): value is string => value !== undefined)
    if (!previous) {
      if (intent.previousAttemptId !== undefined || links.length !== 0) throw new Error(workflowRecoveryCopy.ledger)
    } else {
      if (intent.previousAttemptId !== previous.attemptId || links.length !== 1) throw new Error(workflowRecoveryCopy.ledger)
      const segment = segments.get(links[0])
      if (!segment || segment.commandId !== links[0] || !linkFor(segment, intent, previous, outcomes) || linked.has(links[0])) throw new Error(workflowRecoveryCopy.ledger)
      linked.add(links[0])
    }
    latest.set(intent.taskId, intent)
    counts.set(intent.taskId, count)
  }
  let restartCounts = new Map<string, number>()
  for (const segment of record.execution?.segments.slice(1) ?? []) {
    if (segment.mode !== 'retry' && segment.mode !== 'restart') continue
    const target = segment.mode === 'retry' ? segment.retry : segment.restart
    const predecessor = target && record.intents.find(intent => intent.attemptId === target.attemptId && intent.taskId === target.taskId)
    if (!target || !target.taskId || !target.attemptId || !segments.has(segment.commandId) || !predecessor) throw new Error(workflowRecoveryCopy.ledger)
    if (!linked.has(segment.commandId!)) {
      const pendingProof = segment.mode === 'retry' ? replayEligible(outcomes.get(target.attemptId)) : linkFor(segment, { taskId: target.taskId } as WorkflowIntent, predecessor, outcomes)
      if (!pendingProof || record.intents.some(intent => intent.retryCommandId === segment.commandId || intent.restartCommandId === segment.commandId)) throw new Error(workflowRecoveryCopy.ledger)
    }
    if (segment.mode === 'restart') {
      restartCounts.set(target.taskId, (restartCounts.get(target.taskId) ?? 0) + 1)
      if ((restartCounts.get(target.taskId) ?? 0) > 5) throw new Error(workflowRecoveryCopy.ledger)
    }
  }
}

/** Caller separately proves ownership/settlement before checking this policy. */
export function assertWorkflowRetryTarget(record: WorkflowStoreRecord, target: WorkflowRetryTarget): void {
  validateWorkflowRetryTarget(target)
  if (record.progress.revision !== target.expectedRevision) throw new Error(copy.stale)
  if (record.progress.state !== 'failed' && record.progress.state !== 'blocked') throw new Error(copy.state)
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

export function workflowUnknownSuperseded(record: WorkflowStoreRecord, attemptId: string): boolean {
  const target = record.intents.find(intent => intent.attemptId === attemptId)
  if (!target) return false
  const successor = record.intents.find(intent => intent.previousAttemptId === attemptId && intent.restartCommandId !== undefined)
  const outcome = successor && record.outcomes.find(value => value.attemptId === successor.attemptId)
  return Boolean(successor && outcome?.settled && outcome.state !== 'unknown')
}

export function workflowRetryAdmission(record: WorkflowStoreRecord, taskId: string): Pick<WorkflowIntent, 'previousAttemptId' | 'retryCommandId' | 'restartCommandId'> {
  const previous = record.intents.filter(intent => intent.taskId === taskId)
  if (!previous.length) return {}
  if (previous.length >= WORKFLOW_MAX_TASK_ATTEMPTS) throw new Error(copy.limit)
  const latest = previous.at(-1)!
  const retry = workflowPendingRetry(record, taskId)
  if (retry?.retry) {
    if (latest.attemptId !== retry.retry.attemptId || !replayEligible(record.outcomes.find(outcome => outcome.attemptId === retry.retry!.attemptId))) throw new Error(workflowRecoveryCopy.ledger)
    return { previousAttemptId: retry.retry.attemptId, retryCommandId: retry.commandId! }
  }
  const restart = workflowPendingRestart(record, taskId)
  if (!restart?.restart || latest.attemptId !== restart.restart.attemptId || record.outcomes.find(outcome => outcome.attemptId === restart.restart!.attemptId)?.state !== 'unknown' || record.outcomes.find(outcome => outcome.attemptId === restart.restart!.attemptId)?.settled !== true) throw new Error(workflowRecoveryCopy.ledger)
  return { previousAttemptId: restart.restart.attemptId, restartCommandId: restart.commandId! }
}
