import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace.js'
import { aggregateTurnEvidence } from './aggregate.js'
import { protectToolContent } from './content-policy.js'

const events: TraceEvent[] = [
  { id: 'a', runId: 'r', ts: '2026-01-01T00:00:00Z', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 't', input: { password: 'INPUT_SECRET' } },
  { id: 'b', runId: 'r', ts: '2026-01-01T00:00:01Z', kind: 'tool', stage: 'tool_result', toolUseId: 't', output: 'password=OUTPUT_SECRET' }
]

describe('tool content persistence policy', () => {
  it('retains canonical call identities when source trace is absent; summary is not promoted to full', () => {
    const turnEvidence = aggregateTurnEvidence({ events })
    const turn = protectToolContent({ items: [], turnEvidence, toolContentPolicy: { toolOutput: 'full-redacted' as const } }, '')
    expect(turn.turnEvidence.tools.value).toHaveLength(1)
    expect(turn.turnEvidence.tools.value![0]).toMatchObject({ id: 't', name: 'Bash', status: 'success' })
    expect(turn.turnEvidence.tools.value![0].outputContent).toMatchObject({ source: 'canonical_summary', sourceCompleteness: 'partial', reasons: ['source_truncated'] })
    expect(JSON.stringify(turn)).not.toMatch(/INPUT_SECRET|OUTPUT_SECRET/)
    expect(protectToolContent(turn, '')).toEqual(turn)
  })

  it('preserves unavailable sections and remains byte-for-byte stable after budget-limited replay', () => {
    const turnEvidence = aggregateTurnEvidence({ events })
    turnEvidence.mcps = { status: 'unavailable', quality: 'unavailable', source: [], omissionReason: 'provider does not expose MCP' }
    const turn = protectToolContent({ items: events, turnEvidence, toolContentPolicy: {
      toolOutput: 'full-redacted' as const, toolContentFieldBytes: 15, toolContentTurnBytes: 20
    } }, '')
    expect(turn.turnEvidence.mcps).toEqual(turnEvidence.mcps)
    expect(protectToolContent(turn, '')).toEqual(turn)
    expect(turn.turnEvidence.tools.value![0].inputContent?.storage).toBe('truncated')
  })
})
