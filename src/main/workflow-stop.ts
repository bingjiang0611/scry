import { WORKFLOW_MAX_STOP_REQUESTS, type WorkflowProgress, type WorkflowStopProvenance } from '../shared/workflow'
import type { WorkflowStopTarget } from '../shared/workflow-api'
import { workflowControlCopy } from '../shared/constants/copy'
import type { WorkflowStoreRecord } from './workflow-store-contracts'

const identity = /^[A-Za-z0-9_-]{1,96}$/

export function workflowStopTargetKey(target: WorkflowStopTarget): string {
  return target.kind + ':' + target.id
}

export type WorkflowTargetStopState = {
  targetStops: Map<string, Set<() => boolean>>
  targetLatches: Map<string, boolean>
}

/** A new pending command must never revoke an earlier confirmed stop. */
export function fenceWorkflowTargetStop(entry: Pick<WorkflowTargetStopState, 'targetLatches'>, target: WorkflowStopTarget): void {
  const key = workflowStopTargetKey(target)
  if (!entry.targetLatches.has(key)) entry.targetLatches.set(key, false)
}

export function registerWorkflowTargetStop(entry: WorkflowTargetStopState | undefined, target: WorkflowStopTarget, stop: () => boolean): void {
  if (!entry) return
  const key = workflowStopTargetKey(target)
  const hooks = entry.targetStops.get(key) ?? new Set<() => boolean>()
  hooks.add(stop)
  entry.targetStops.set(key, hooks)
  if (entry.targetLatches.get(key) === true) stop()
}

export function releaseWorkflowTargetStop(entry: WorkflowTargetStopState | undefined, target: WorkflowStopTarget, stop: () => boolean): void {
  if (!entry) return
  const key = workflowStopTargetKey(target)
  const hooks = entry.targetStops.get(key)
  if (!hooks) return
  hooks.delete(stop)
  if (!hooks.size) entry.targetStops.delete(key)
}

export function validateWorkflowStopTarget(value: unknown): WorkflowStopTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(workflowControlCopy.invalidStopReceipt)
  const target = value as Record<string, unknown>
  if (Object.keys(target).length !== 2 || (target.kind !== 'attempt' && target.kind !== 'system') || typeof target.id !== 'string' || !identity.test(target.id)) throw new Error(workflowControlCopy.invalidStopReceipt)
  return { kind: target.kind, id: target.id }
}

export function validateWorkflowStopRequests(record: WorkflowStoreRecord): void {
  const requests = record.stopRequests
  if (requests === undefined) return
  if (!Array.isArray(requests) || requests.length > WORKFLOW_MAX_STOP_REQUESTS) throw new Error(workflowControlCopy.invalidStopReceipt)
  const attemptIds = new Set(record.intents.filter(intent => intent.workflowId === record.preview.workflowId).map(intent => intent.attemptId))
  const systemIds = new Set((record.systemIntents ?? []).map(intent => intent.stepId))
  const commands = new Set<string>()
  for (const request of requests) {
    if (!request || typeof request !== 'object' || !('commandId' in request) || !('requestedAt' in request) ||
      Object.keys(request).some(key => key !== 'commandId' && key !== 'requestedAt' && key !== 'target' && key !== 'provenance') ||
      typeof request.commandId !== 'string' || !identity.test(request.commandId) || !Number.isFinite(request.requestedAt) || request.requestedAt < 0 || commands.has(request.commandId)) throw new Error(workflowControlCopy.invalidStopReceipt)
    commands.add(request.commandId)
    if ('provenance' in request) {
      validateWorkflowStopProvenance(request.provenance)
    }
    if (!('target' in request)) continue
    const target = validateWorkflowStopTarget(request.target)
    if (target.kind === 'attempt' ? !attemptIds.has(target.id) : !systemIds.has(target.id)) throw new Error(workflowControlCopy.invalidStopReceipt)
  }
}

/** Derive display-only intent from the sole control ledger; never change accepted outcomes. */
export function projectWorkflowStopIntents(progress: WorkflowProgress, requests: WorkflowStoreRecord['stopRequests']): WorkflowProgress {
  const intents = new Map<string, { commandId: string; requestedAt: number; provenance?: WorkflowStopProvenance }>()
  for (const request of requests ?? []) {
    if (request.target) intents.set(workflowStopTargetKey(request.target), { commandId: request.commandId, requestedAt: request.requestedAt, ...(request.provenance ? { provenance: request.provenance } : {}) })
  }
  if (!intents.size) return progress
  return {
    ...progress,
    attempts: progress.attempts.map(attempt => {
      const stopRequested = intents.get('attempt:' + attempt.attemptId)
      return stopRequested ? { ...attempt, stopRequested } : attempt
    }),
    ...(progress.systemSteps ? { systemSteps: progress.systemSteps.map(step => {
      const stopRequested = intents.get('system:' + step.stepId)
      return stopRequested ? { ...step, stopRequested } : step
    }) } : {})
  }
}

export function sameWorkflowStopTarget(left: WorkflowStopTarget | undefined, right: WorkflowStopTarget | undefined): boolean {
  return left?.kind === right?.kind && left?.id === right?.id
}

export function sameWorkflowStopProvenance(left: WorkflowStopProvenance | undefined, right: WorkflowStopProvenance | undefined): boolean {
  return left?.source === right?.source && left?.policy === right?.policy &&
    left?.trigger.nodeId === right?.trigger.nodeId && left?.trigger.phase === right?.trigger.phase &&
    left?.trigger.frameId === right?.trigger.frameId
}

function validateWorkflowStopProvenance(value: unknown): asserts value is WorkflowStopProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(workflowControlCopy.invalidStopReceipt)
  const provenance = value as Record<string, unknown>
  const trigger = provenance.trigger
  if (provenance.source !== 'auto' || provenance.policy !== 'fail_fast' || !trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw new Error(workflowControlCopy.invalidStopReceipt)
  const candidate = trigger as Record<string, unknown>
  const phases = new Set(['failed', 'blocked', 'unknown', 'stopped'])
  if (Object.keys(provenance).some(key => key !== 'source' && key !== 'policy' && key !== 'trigger') || Object.keys(candidate).some(key => key !== 'nodeId' && key !== 'phase' && key !== 'frameId') || typeof candidate.nodeId !== 'string' || !identity.test(candidate.nodeId) || typeof candidate.phase !== 'string' || !phases.has(candidate.phase) || (typeof candidate.frameId !== 'string' || !identity.test(candidate.frameId))) throw new Error(workflowControlCopy.invalidStopReceipt)
}
