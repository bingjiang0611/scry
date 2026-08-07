import { describe, expect, it } from 'vitest'
import { isAgentTurnRecord } from './turn-record'

const availableEmpty = () => ({
  status: 'available',
  quality: 'exact',
  source: ['fixture'],
  value: []
})

function record(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    recordKind: 'agent_turn',
    sequence: 1,
    recordId: 'record-1',
    recorderVersion: '0.2.6',
    workspace: { id: 'fixture', root: '/repo' },
    provider: { id: 'codex' },
    sessionId: 'session-1',
    generation: 1,
    turnIndex: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1_000,
    status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'x' } },
    assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'y' } },
    tools: availableEmpty(),
    skills: availableEmpty(),
    mcps: availableEmpty(),
    hooks: availableEmpty(),
    usage: { status: 'unavailable', quality: 'unavailable', source: [] },
    files: availableEmpty(),
    diff: availableEmpty(),
    dangerousOperations: availableEmpty(),
    errors: availableEmpty()
  }
}

describe('AgentTurnRecord model timing compatibility', () => {
  it('accepts old schema v1 records that predate modelTiming', () => {
    expect(isAgentTurnRecord(record())).toBe(true)
  })

  it('accepts valid optional compactions and rejects malformed token counts', () => {
    const valid = record()
    valid.compactions = {
      status: 'available',
      quality: 'exact',
      source: ['fixture'],
      value: [{
        eventId: 'compact-1',
        at: '2026-01-01T00:00:00.000Z',
        trigger: 'auto',
        preTokens: 100,
        postTokens: 20
      }]
    }
    expect(isAgentTurnRecord(valid)).toBe(true)

    const malformed = structuredClone(valid)
    ;((malformed.compactions as { value: Array<{ preTokens: number }> }).value)[0].preTokens = -1
    expect(isAgentTurnRecord(malformed)).toBe(false)
  })

  it('accepts valid optional timing and rejects malformed timing instead of treating it as zero', () => {
    const valid = record()
    valid.modelTiming = {
      status: 'available',
      quality: 'estimated',
      source: ['scry_provider_adapter'],
      value: {
        method: 'response_intervals',
        cumulativeMs: 500,
        occupiedMs: 500,
        overlapMs: 0,
        totalCalls: 1,
        timedCalls: 1,
        root: { totalCalls: 1, timedCalls: 1, cumulativeMs: 500 },
        subagents: { totalCalls: 0, timedCalls: 0 },
        calls: [{
          responseId: 'response-1',
          scope: 'root',
          completedAt: '2026-01-01T00:00:00.500Z',
          durationMs: 500,
          source: 'observed',
          boundary: 'turn_or_activity_end'
        }]
      }
    }
    expect(isAgentTurnRecord(valid)).toBe(true)

    const malformed = structuredClone(valid)
    ;((malformed.modelTiming as { value: { cumulativeMs: unknown } }).value).cumulativeMs = -1
    expect(isAgentTurnRecord(malformed)).toBe(false)
  })

  it('accepts valid optional model segments and rejects malformed ordering', () => {
    const valid = record()
    valid.modelSegments = {
      status: 'available',
      quality: 'exact',
      source: ['fixture'],
      value: [{ order: 0, at: '2026-01-01T00:00:00.000Z', kind: 'text', text: 'working' }]
    }
    expect(isAgentTurnRecord(valid)).toBe(true)

    const malformed = structuredClone(valid)
    ;((malformed.modelSegments as { value: Array<{ order: number }> }).value)[0].order = -1
    expect(isAgentTurnRecord(malformed)).toBe(false)
  })
})
