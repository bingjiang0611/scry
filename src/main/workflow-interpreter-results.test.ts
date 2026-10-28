import { describe, expect, it } from 'vitest'
import { workflowCompletionPhase } from './workflow-interpreter-results'

describe('control completion evidence', () => {
  it.each(['completed', 'failed', 'blocked', 'stopped', 'unknown'] as const)('retains an unknown control checkpoint over %s effect evidence', base => {
    expect(workflowCompletionPhase(base, 'unknown')).toBe('unknown')
  })

  it('preserves existing known-effect precedence and an absent terminal phase', () => {
    expect(workflowCompletionPhase('blocked', 'failed')).toBe('blocked')
    expect(workflowCompletionPhase('failed', 'blocked')).toBe('failed')
    expect(workflowCompletionPhase('completed', 'blocked')).toBe('blocked')
    expect(workflowCompletionPhase('unknown', 'completed')).toBe('unknown')
    expect(workflowCompletionPhase('failed')).toBe('failed')
    expect(workflowCompletionPhase('completed')).toBe('completed')
  })
})
