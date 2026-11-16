import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace.js'
import { isToolContent } from '../../shared/tool-content.js'
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
    expect(JSON.stringify(turn)).toContain('INPUT_SECRET')
    expect(JSON.stringify(turn)).toContain('OUTPUT_SECRET')
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
    // 15 bytes cannot hold a JSON object plus the marker that names what was dropped, so this field
    // is omitted rather than cut: an unparseable prefix claiming to be JSON is worse than a stated
    // omission, and the durable reference above still has the body.
    expect(turn.turnEvidence.tools.value![0].inputContent).toMatchObject({ storage: 'omitted', savedBytes: 0 })
  })

  it('truncates a JSON body only into a form that still parses', () => {
    const long: TraceEvent[] = [
      { id: 'a', runId: 'r', ts: '2026-01-01T00:00:00Z', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 't', input: { password: 'p'.repeat(200) } }
    ]
    const turnEvidence = aggregateTurnEvidence({ events: long })
    const turn = protectToolContent({ items: long, turnEvidence, toolContentPolicy: {
      toolOutput: 'full-redacted' as const, toolContentFieldBytes: 64, toolContentTurnBytes: 128
    } }, '')
    const content = turn.turnEvidence.tools.value![0].inputContent
    expect(content?.storage).toBe('truncated')
    expect(content?.encoding).toBe('json')
    // The long value keeps a prefix; what remains is still JSON and still says how much it replaced.
    const parsed = JSON.parse(content!.content!) as Record<string, unknown>
    // Either the long value keeps a bounded prefix, or the whole body becomes one marker that
    // states how many bytes it replaced. Both parse; neither is a byte cut.
    expect(parsed.password ?? parsed.originalBytes).toBeDefined()
    if (parsed.originalBytes !== undefined) expect(parsed.originalBytes).toBe(Buffer.byteLength(JSON.stringify({ password: 'p'.repeat(200) })))
    expect(isToolContent(content!)).toBe(true)
  })
})
