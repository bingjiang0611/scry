import { describe, expect, it } from 'vitest'
import type { WorkflowAttemptOutcome } from '../shared/workflow'
import type { WorkflowStoreRecord } from './workflow-store'
import { validateWorkflowAttemptChains, validateWorkflowRestartTarget, workflowPendingRestart, workflowUnknownSuperseded } from './workflow-retry'

const taskId = 'workflow-1:' + 'a'.repeat(64) + ':node'
const outcome = (attemptId: string, state: WorkflowAttemptOutcome['state'] = 'unknown'): WorkflowAttemptOutcome => ({
  attemptId, taskId, nodeId: 'node', role: 'worker', providerId: 'claude', actualModelStatus: 'unknown', state, settled: true
})
const intent = (attemptId: string, links: { previousAttemptId?: string; retryCommandId?: string; restartCommandId?: string } = {}) => ({
  workflowId: 'workflow-1', programRevision: 'b'.repeat(64), taskId, attemptId, role: 'worker' as const, providerId: 'claude' as const, createdAt: 1, ...links
})
const record = (intents: WorkflowStoreRecord['intents'], outcomes: WorkflowAttemptOutcome[], extraSegments: NonNullable<WorkflowStoreRecord['execution']>['segments'] = []): WorkflowStoreRecord => ({
  preview: {} as WorkflowStoreRecord['preview'], progress: { dispatchAttempts: intents.length } as WorkflowStoreRecord['progress'], intents, outcomes,
  execution: { version: 2, epoch: 'epoch', owner: { pid: 1, instanceId: 'owner', state: 'active' }, segments: [
    { id: 'start', mode: 'start', createdAt: 1 }, ...extraSegments
  ] }
})

describe('workflow restart/retry ledger contracts', () => {
  it('strictly validates restart targets and rejects colliding or extra fields', () => {
    expect(validateWorkflowRestartTarget({ taskId, attemptId: 'attempt', expectedRevision: 1 })).toEqual({ taskId, attemptId: 'attempt', expectedRevision: 1 })
    expect(() => validateWorkflowRestartTarget({ taskId, attemptId: 'attempt', expectedRevision: 1, reason: 'stalled' })).toThrow()
    expect(() => validateWorkflowRestartTarget({ taskId: 'wrong', attemptId: 'attempt', expectedRevision: 1 })).toThrow()
  })

  it('selects the latest unconsumed restart, not the first pending segment', () => {
    const first = { id: 'restart-1', generationId: 'restart-1', commandId: 'command-1', mode: 'restart' as const, createdAt: 2, restart: { taskId, attemptId: 'attempt-1', expectedRevision: 1, reason: 'stalled' as const } }
    const second = { id: 'restart-2', generationId: 'restart-2', commandId: 'command-2', mode: 'restart' as const, createdAt: 3, restart: { taskId, attemptId: 'attempt-2', expectedRevision: 2, reason: 'reply_lost' as const } }
    const base = record([intent('attempt-1')], [outcome('attempt-1')], [first, second])
    expect(workflowPendingRestart(base, taskId)?.commandId).toBe('command-2')
    base.intents.push(intent('attempt-2', { previousAttemptId: 'attempt-1', restartCommandId: 'command-1' }))
    expect(workflowPendingRestart(base, taskId)?.commandId).toBe('command-2')
  })

  it('requires exactly one successor link, forbids first-intent links, and accepts only settled unknown restart targets', () => {
    const old = intent('attempt-1'), next = intent('attempt-2', { previousAttemptId: 'attempt-1', restartCommandId: 'restart-1' })
    const segment = { id: 'restart-1', generationId: 'restart-1', commandId: 'restart-1', mode: 'restart' as const, createdAt: 2, restart: { taskId, attemptId: 'attempt-1', expectedRevision: 1, reason: 'stalled' as const } }
    expect(() => validateWorkflowAttemptChains(record([old, next], [outcome('attempt-1'), outcome('attempt-2', 'completed')], [
      { id: 'continue', generationId: 'continue', commandId: 'continue', mode: 'continue', createdAt: 1 },
      { id: 'revision', generationId: 'revision', commandId: 'revision', mode: 'revision', createdAt: 1, expectedRevision: 1 },
      segment
    ]))).not.toThrow()
    expect(() => validateWorkflowAttemptChains(record([intent('attempt-1', { restartCommandId: 'restart-1' })], [outcome('attempt-1')], [segment]))).toThrow()
    expect(() => validateWorkflowAttemptChains(record([old, intent('attempt-2', { previousAttemptId: 'attempt-1', restartCommandId: 'restart-1', retryCommandId: 'retry-1' })], [outcome('attempt-1'), outcome('attempt-2')], [segment]))).toThrow()
    expect(() => validateWorkflowAttemptChains(record([old, next], [outcome('attempt-1', 'failed'), outcome('attempt-2')], [segment]))).toThrow()
  })

  it('closes unknown ownership only after a settled successor', () => {
    const segment = { id: 'restart-1', generationId: 'restart-1', commandId: 'restart-1', mode: 'restart' as const, createdAt: 2, restart: { taskId, attemptId: 'attempt-1', expectedRevision: 1, reason: 'stalled' as const } }
    const old = intent('attempt-1'), next = intent('attempt-2', { previousAttemptId: 'attempt-1', restartCommandId: 'restart-1' })
    expect(workflowUnknownSuperseded(record([old, next], [outcome('attempt-1'), outcome('attempt-2', 'completed')], [segment]), 'attempt-1')).toBe(true)
    expect(workflowUnknownSuperseded(record([old, next], [outcome('attempt-1'), outcome('attempt-2', 'unknown')], [segment]), 'attempt-1')).toBe(false)
  })
})
