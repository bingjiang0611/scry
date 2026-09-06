import { describe, expect, it } from 'vitest'
import {
  completedOpenCodeTurnBoundary,
  completedPiTurnForkTarget,
  completedTranscriptTurnBoundary
} from './session-fork-boundary'

describe('provider completed-turn fork boundaries', () => {
  it('keeps the selected Claude/Qoder response and stops before the next user turn', () => {
    const messages = [
      { uuid: 'user-1', type: 'user' },
      { uuid: 'assistant-1', type: 'assistant' },
      { uuid: 'progress-1', type: 'progress' },
      { uuid: 'user-2', type: 'user' },
      { uuid: 'assistant-2', type: 'assistant' }
    ]
    expect(completedTranscriptTurnBoundary(messages, 'user-1', 'Claude')).toBe('progress-1')
    expect(completedTranscriptTurnBoundary(messages, 'user-2', 'Claude')).toBe('assistant-2')
  })

  it('uses the final OpenCode response message before the next user prompt', () => {
    const messages = [
      { id: 'user-1', role: 'user' },
      { id: 'assistant-1', role: 'assistant' },
      { id: 'user-2', role: 'user' },
      { id: 'assistant-2', role: 'assistant' }
    ]
    expect(completedOpenCodeTurnBoundary(messages, 'user-1')).toBe('assistant-1')
    expect(completedOpenCodeTurnBoundary(messages, 'user-2')).toBe('assistant-2')
  })

  it('forks before the next Pi user entry or clones the active leaf for the final turn', () => {
    const entries = [
      { id: 'user-1', parentId: null, type: 'message', role: 'user' },
      { id: 'assistant-1', parentId: 'user-1', type: 'message', role: 'assistant' },
      { id: 'user-2', parentId: 'assistant-1', type: 'message', role: 'user' },
      { id: 'assistant-2', parentId: 'user-2', type: 'message', role: 'assistant' }
    ]
    expect(completedPiTurnForkTarget(entries, 'assistant-2', 'user-1')).toEqual({
      operation: 'fork_before', entryId: 'user-2'
    })
    expect(completedPiTurnForkTarget(entries, 'assistant-2', 'user-2')).toEqual({ operation: 'clone_leaf' })
  })

  it('rejects boundaries that do not prove a completed response', () => {
    expect(() => completedTranscriptTurnBoundary([{ uuid: 'user', type: 'user' }], 'user', 'Qoder'))
      .toThrow('完整响应边界')
    expect(() => completedOpenCodeTurnBoundary([{ id: 'user', role: 'user' }], 'user'))
      .toThrow('完整响应边界')
  })
})
