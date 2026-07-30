import { describe, expect, it } from 'vitest'
import type { AgentTurnRecord, Evidence } from '../../shared/turn-record'
import { compactModelTiming, summarizeTurnRecords } from './turns-summary'

function emptyEvidence(): Evidence<never[]> {
  return { status: 'available', quality: 'exact', source: ['fixture'], value: [] }
}

function record(
  sequence: number,
  modelTiming?: AgentTurnRecord['modelTiming']
): AgentTurnRecord {
  return {
    schemaVersion: 1,
    recordKind: 'agent_turn',
    sequence,
    recordId: `${sequence}`.padStart(32, '0'),
    recorderVersion: 'test',
    workspace: { id: 'fixture', root: '/repo' },
    provider: { id: 'codex' },
    sessionId: 'session-1',
    generation: sequence,
    turnIndex: sequence,
    startedAt: `2026-01-01T00:00:0${sequence}.000Z`,
    completedAt: `2026-01-01T00:00:0${sequence + 1}.000Z`,
    durationMs: 1_000,
    status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'x', textHash: 'hash' } },
    assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'y', textHash: 'hash' } },
    tools: emptyEvidence(),
    skills: emptyEvidence(),
    mcps: emptyEvidence(),
    hooks: emptyEvidence(),
    usage: { status: 'unavailable', quality: 'unavailable', source: [] },
    ...(modelTiming ? { modelTiming } : {}),
    files: emptyEvidence(),
    diff: emptyEvidence(),
    dangerousOperations: emptyEvidence(),
    errors: emptyEvidence()
  }
}

describe('turn CLI model timing summaries', () => {
  it('keeps old records readable without turning unknown timing into zero', () => {
    expect(compactModelTiming(record(1))).toEqual({
      status: 'unavailable',
      quality: 'unavailable',
      method: null,
      cumulativeMs: null,
      occupiedMs: null,
      timedCalls: null,
      totalCalls: null,
      source: []
    })
  })

  it('aggregates known model timing with explicit turn and call coverage', () => {
    const observed = {
      status: 'available',
      quality: 'estimated',
      source: ['scry_provider_adapter'],
      value: {
        method: 'response_intervals',
        cumulativeMs: 800,
        occupiedMs: 600,
        totalCalls: 2,
        timedCalls: 2,
        root: { totalCalls: 1, timedCalls: 1, cumulativeMs: 300 },
        subagents: { totalCalls: 1, timedCalls: 1, cumulativeMs: 500 }
      }
    } satisfies NonNullable<AgentTurnRecord['modelTiming']>
    const summary = summarizeTurnRecords([record(1, observed), record(2)])

    expect(summary.modelTiming).toMatchObject({
      cumulativeMs: 800,
      occupiedMs: 600,
      rootCumulativeMs: 300,
      subagentCumulativeMs: 500,
      knownTurns: 1,
      totalTurns: 2,
      complete: false,
      responseCallCoverage: { timedCalls: 2, totalCalls: 2, knownTurns: 1 },
      qualityCounts: { estimated: 1, unavailable: 1 },
      methodCounts: { response_intervals: 1 }
    })
  })
})
