import { describe, expect, it } from 'vitest'
import { workflowProgressSnapshot, type WorkflowProgress } from './workflow'

describe('workflow progress snapshots', () => {
  it('preserves the total across repeated bounded views without exposing intermediate output', () => {
    const progress: WorkflowProgress = {
      workflowId: 'root', programRevision: 'program', workspace: '/fixture', goal: 'test',
      state: 'running', dispatchAttempts: 64, slots: { limit: 2, inUse: 0, queued: 0 }, updatedAt: 1,
      attempts: Array.from({ length: 64 }, (_, index) => ({
        attemptId: `attempt-${index}`, taskId: `root:task-${index}`, nodeId: `node-${index}`,
        role: 'worker', providerId: 'codex', actualModelStatus: 'unknown', state: 'completed',
        settled: true, output: 'intermediate output'
      }))
    }
    const first = workflowProgressSnapshot(progress)
    const second = workflowProgressSnapshot(first)
    expect(first.attempts).toHaveLength(32)
    expect(second.attempts).toHaveLength(32)
    expect(first.outcomeCount).toBe(64)
    expect(second.outcomeCount).toBe(64)
    expect(second.attempts[0].attemptId).toBe('attempt-32')
    expect(second.attempts.every(attempt => !Object.hasOwn(attempt, 'output'))).toBe(true)
    expect(progress.attempts).toHaveLength(64)
    expect(progress.attempts[0].output).toBe('intermediate output')
  })
})
