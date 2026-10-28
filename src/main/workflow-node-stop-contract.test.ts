import { describe, expect, it } from 'vitest'
import { validateWorkflowStopRequests, validateWorkflowStopTarget } from './workflow-stop'
import type { WorkflowStoreRecord } from './workflow-store'

const record = (): WorkflowStoreRecord => ({
  preview: { workflowId: 'workflow-test', programRevision: 'revision-test', workspace: '/tmp/workflow', userGoal: 'test', state: 'ready', program: { schemaVersion: 1, workflowId: 'workflow-test', programRevision: 'revision-test', workspace: '/tmp/workflow', userGoal: 'test', roles: [], body: { kind: 'sequence', blockId: 'root', blocks: [] } } } as never,
  progress: { workflowId: 'workflow-test', programRevision: 'revision-test', workspace: '/tmp/workflow', goal: 'test', state: 'running', attempts: [], dispatchAttempts: 0, slots: { limit: 1, inUse: 0, queued: 0 }, updatedAt: 1 },
  intents: [{ workflowId: 'workflow-test', programRevision: 'revision-test', taskId: 'workflow-test:task:node', attemptId: 'attempt-1', role: 'worker', providerId: 'claude', createdAt: 1 }],
  outcomes: [],
  systemIntents: [{ stepId: 'system-1', taskId: 'workflow-test:step:node', nodeId: 'node', programRevision: 'revision-test', kind: 'check', createdAt: 1 }]
})

describe('durable node stop contract', () => {
  it('accepts only opaque attempt/system targets', () => {
    expect(validateWorkflowStopTarget({ kind: 'attempt', id: 'attempt-1' })).toEqual({ kind: 'attempt', id: 'attempt-1' })
    expect(() => validateWorkflowStopTarget({ kind: 'attempt', id: '../attempt' })).toThrow()
    expect(() => validateWorkflowStopTarget({ kind: 'attempt', id: 'attempt-1', pid: 1 })).toThrow()
  })

  it('joins targeted receipts to this root intent and rejects unknown targets', () => {
    const current = record()
    current.stopRequests = [{ commandId: 'stop-attempt', requestedAt: 2, target: { kind: 'attempt', id: 'attempt-1' } }, { commandId: 'stop-system', requestedAt: 3, target: { kind: 'system', id: 'system-1' } }]
    expect(() => validateWorkflowStopRequests(current)).not.toThrow()
    current.stopRequests.push({ commandId: 'foreign', requestedAt: 4, target: { kind: 'attempt', id: 'other-root-attempt' } })
    expect(() => validateWorkflowStopRequests(current)).toThrow()
  })
})
