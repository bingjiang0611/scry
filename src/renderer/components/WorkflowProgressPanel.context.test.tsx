import { describe, expect, it } from 'vitest'
import type { WorkflowProgress } from '@shared/workflow'
import { mergeWorkflowProgress } from './WorkflowProgressPanel'

const progress: WorkflowProgress = {
  workflowId: 'root', programRevision: 'program', workspace: '/fixture', goal: 'test',
  state: 'running', attempts: [], dispatchAttempts: 1, slots: { limit: 1, inUse: 1, queued: 0 },
  updatedAt: 1, revision: 4,
  live: { epoch: 'active-epoch', revision: 10, status: 'tool_wait', coverage: 'partial', automaticStall: 'unsupported',
    attempts: [], attemptCount: 0, truncated: false, observedAt: 1 }
}

describe('workflow live progress ordering', () => {
  it('does not let a delayed observation overwrite newer evidence at the same durable revision', () => {
    const stale = { ...progress, live: { ...progress.live!, revision: 9, status: 'unknown' as const } }
    expect(mergeWorkflowProgress([progress], [stale])).toEqual([progress])
  })
  it('does not lose current live evidence to a stale history snapshot without it', () => {
    const { live: _live, ...stale } = progress
    expect(mergeWorkflowProgress([progress], [stale])).toEqual([progress])
  })
  it('accepts a newer observation without requiring a journal write', () => {
    const next = { ...progress, live: { ...progress.live!, revision: 11, status: 'permission_wait' as const } }
    expect(mergeWorkflowProgress([progress], [next])).toEqual([next])
  })
  it('accepts the durable terminal state and clears live evidence', () => {
    const { live: _live, ...value } = progress
    const done = { ...value, revision: 5, state: 'completed' as const }
    expect(mergeWorkflowProgress([progress], [done])).toEqual([done])
  })
})
