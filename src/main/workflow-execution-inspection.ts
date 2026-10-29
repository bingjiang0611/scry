import type { WorkflowAttemptOutcome } from '../shared/workflow'
import type { WorkflowExecutionInspection, WorkflowExecutionInspectionRequest, WorkflowAttemptInspectionRecord, WorkflowSystemInspectionRecord, WorkflowExecutionInspectionFrame, WorkflowAttemptInspectionIntent, WorkflowAttemptInspectionOutcome, WorkflowSystemInspectionIntent, WorkflowSystemInspectionOutcome } from '../shared/workflow-inspection'
import type { WorkflowSystemOutcome } from '../shared/workflow-system'
import type { WorkflowIntent, WorkflowStoreRecord } from './workflow-store'
import type { WorkflowSystemIntent } from '../shared/workflow-system'
import type { WorkflowClassifierIntent, WorkflowClassifierOutcome } from '../shared/workflow-classifier'
import { WORKFLOW_EXECUTION_INSPECTION_PAGE_SIZE } from '../shared/workflow-inspection'
import { normalizeWorkflowUsage, type WorkflowUsage } from '../shared/workflow-usage'

import { workflowIntentFrameId } from './workflow-progress'

const ERROR_LIMIT = 4096

type ErrorProjection = { error?: string; errorTruncated?: boolean }
function errorProjection(error: string | undefined): ErrorProjection {
  if (error === undefined) return {}
  return error.length > ERROR_LIMIT ? { error: error.slice(0, ERROR_LIMIT), errorTruncated: true } : { error }
}

/** Durable task IDs end with the admitted block ID; this does not traverse the current program. */
function recordedNode(taskId: string): string {
  const parts = taskId.split(':')
  return parts.at(-1)!
}
function frame(reference: string | undefined): WorkflowExecutionInspectionFrame {
  return reference ? { state: 'available', frameId: reference } : { state: 'unavailable', reason: 'missing_reference' }
}
function intentState<T>(value: T | undefined, reason: 'missing_intent'): { state: 'available'; value: T } | { state: 'unavailable'; reason: 'missing_intent' } {
  return value === undefined ? { state: 'unavailable', reason } : { state: 'available', value }
}
function outcomeState<T>(value: T | undefined, reason: 'missing_outcome'): { state: 'available'; value: T } | { state: 'unavailable'; reason: 'missing_outcome' } {
  return value === undefined ? { state: 'unavailable', reason } : { state: 'available', value }
}
function inspectedUsage(value: unknown): WorkflowUsage {
  return normalizeWorkflowUsage(value) ?? { provenance: 'unavailable', source: 'none', reason: value === undefined ? 'Usage evidence was not recorded' : 'Recorded usage evidence is invalid' }
}

function attemptIntent(intent: WorkflowIntent): WorkflowAttemptInspectionIntent {
  return {
    nodeId: recordedNode(intent.taskId), programRevision: intent.programRevision, createdAt: intent.createdAt,
    role: intent.role, providerId: intent.providerId,
    ...(intent.requestedModel !== undefined ? { requestedModel: intent.requestedModel } : {}),
    ...(intent.previousAttemptId !== undefined ? { previousAttemptId: intent.previousAttemptId } : {}),
    ...(intent.retryCommandId !== undefined ? { retryCommandId: intent.retryCommandId } : {}),
    frame: frame(workflowIntentFrameId(intent))
  }
}

function attemptOutcome(outcome: WorkflowAttemptOutcome): WorkflowAttemptInspectionOutcome {
  return {
    nodeId: outcome.nodeId, role: outcome.role, providerId: outcome.providerId,
    ...(outcome.requestedModel !== undefined ? { requestedModel: outcome.requestedModel } : {}),
    ...(outcome.actualModel !== undefined ? { actualModel: outcome.actualModel } : {}),
    actualModelStatus: outcome.actualModelStatus, state: outcome.state, settled: outcome.settled, usage: inspectedUsage(outcome.usage),
    ...(outcome.runId !== undefined ? { runId: outcome.runId } : {}), ...errorProjection(outcome.error)
  }
}

function systemIntent(intent: WorkflowSystemIntent): WorkflowSystemInspectionIntent {
  return { nodeId: intent.nodeId, programRevision: intent.programRevision, createdAt: intent.createdAt, kind: intent.kind, frame: frame(intent.frameId) }
}
function classifierIntent(intent: WorkflowClassifierIntent): import('../shared/workflow-inspection').WorkflowClassifierInspectionIntent {
  return { classifierId: intent.classifierId, nodeId: intent.nodeId, programRevision: intent.programRevision, criteria: intent.criteria, ...(intent.model ? { model: intent.model } : {}), kind: intent.kind, frame: frame(intent.frame.frameId), createdAt: intent.createdAt }
}
function classifierOutcome(outcome: WorkflowClassifierOutcome): import('../shared/workflow-inspection').WorkflowClassifierInspectionOutcome {
  return { state: outcome.state, settled: outcome.settled, usage: inspectedUsage(outcome.usage), ...(outcome.value === undefined ? {} : { value: outcome.value }), ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }), ...(outcome.probability === undefined ? {} : { probability: outcome.probability }), ...(outcome.reason === undefined ? {} : { reason: outcome.reason.slice(0, ERROR_LIMIT) }) }
}
function systemOutcome(outcome: WorkflowSystemOutcome): WorkflowSystemInspectionOutcome {
  return { stepId: outcome.stepId, taskId: outcome.taskId, state: outcome.state, settled: outcome.settled, startedAt: outcome.startedAt, finishedAt: outcome.finishedAt,
    ...(outcome.resultRef ? { resultRef: outcome.resultRef } : {}), ...errorProjection(outcome.error) }
}

function page<T, U>(rows: T[], offset: number, project: (row: T) => U) {
  const selected = rows.slice(offset, offset + WORKFLOW_EXECUTION_INSPECTION_PAGE_SIZE)
  return { total: rows.length, records: selected.map(project),
    ...(offset + selected.length < rows.length ? { nextOffset: offset + selected.length } : {}) }
}

function attempts(record: WorkflowStoreRecord, nodeId: string | undefined, offset: number) {
  const rows = new Map<string, { taskId: string; intent?: WorkflowIntent; outcome?: WorkflowAttemptOutcome }>()
  for (const intent of record.intents) rows.set(intent.attemptId, { taskId: intent.taskId, intent })
  for (const outcome of record.outcomes) {
    const row = rows.get(outcome.attemptId)
    if (row) row.outcome = outcome
    else rows.set(outcome.attemptId, { taskId: outcome.taskId, outcome })
  }
  const matching = [...rows.values()].filter(row => nodeId === undefined || row.outcome?.nodeId === nodeId || (row.intent && recordedNode(row.intent.taskId) === nodeId))
  return page(matching, offset, (row): WorkflowAttemptInspectionRecord => ({
    attemptId: row.intent?.attemptId ?? row.outcome!.attemptId, taskId: row.taskId,
    intent: intentState(row.intent && attemptIntent(row.intent), 'missing_intent'),
    outcome: outcomeState(row.outcome && attemptOutcome(row.outcome), 'missing_outcome')
  }))
}

function classifiers(record: WorkflowStoreRecord, nodeId: string | undefined, offset: number) {
  const rows = new Map<string, { intent?: WorkflowClassifierIntent; outcome?: WorkflowClassifierOutcome }>()
  for (const intent of record.classifierIntents ?? []) rows.set(intent.classifierId, { intent })
  for (const outcome of record.classifierOutcomes ?? []) rows.set(outcome.classifierId, { ...rows.get(outcome.classifierId), outcome })
  const matching = [...rows.values()].filter(row => nodeId === undefined || row.intent?.nodeId === nodeId)
  return page(matching, offset, row => ({ classifierId: row.intent?.classifierId ?? row.outcome!.classifierId,
    stepId: row.intent?.classifierId ?? row.outcome!.classifierId, taskId: row.intent?.nodeId ?? row.outcome!.classifierId,
    intent: intentState(row.intent && classifierIntent(row.intent), 'missing_intent'), outcome: outcomeState(row.outcome && classifierOutcome(row.outcome), 'missing_outcome') }))
}

function systems(record: WorkflowStoreRecord, nodeId: string | undefined, offset: number) {
  const rows = new Map<string, { taskId: string; intent?: WorkflowSystemIntent; outcome?: WorkflowSystemOutcome }>()
  for (const intent of record.systemIntents ?? []) rows.set(intent.stepId, { taskId: intent.taskId, intent })
  for (const outcome of record.systemOutcomes ?? []) {
    const row = rows.get(outcome.stepId)
    if (row) row.outcome = outcome
    else rows.set(outcome.stepId, { taskId: outcome.taskId, outcome })
  }
  const matching = [...rows.values()].filter(row => nodeId === undefined || row.intent?.nodeId === nodeId)
  return page(matching, offset, (row): WorkflowSystemInspectionRecord => ({
    stepId: row.intent?.stepId ?? row.outcome!.stepId, taskId: row.taskId,
    intent: intentState(row.intent && systemIntent(row.intent), 'missing_intent'),
    outcome: outcomeState(row.outcome && systemOutcome(row.outcome), 'missing_outcome')
  }))
}

export function projectWorkflowExecution(record: WorkflowStoreRecord, request: WorkflowExecutionInspectionRequest, observedAt: number): WorkflowExecutionInspection {
  const offset = request.offset ?? 0
  const selected = request.kind === 'attempts' ? attempts(record, request.nodeId, offset) : request.kind === 'systems' ? systems(record, request.nodeId, offset) : classifiers(record, request.nodeId, offset)
  return {
    state: 'available', source: 'canonical_ledger', observedAt, workflowId: record.preview.workflowId,
    programRevision: record.preview.programRevision, kind: request.kind, offset, ...selected
  }
}
