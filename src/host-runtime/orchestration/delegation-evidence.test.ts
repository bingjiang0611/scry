import { describe, expect, it } from 'vitest'
import {
  aggregateDelegatedUsage,
  buildTaskSummaryEvidence,
  countUserTurnsWithAuthor,
  detectParallelWorkspaceOverlap
} from './delegation-evidence'

describe('P6-1 evidence & usage semantics (evidence §E1-E4)', () => {
  it('inherits archive status/quality in task summary and marks empty final message unavailable', () => {
    const inferred = buildTaskSummaryEvidence({
      status: 'available',
      quality: 'inferred',
      source: ['trace-archive:r1'],
      value: 'hello world'
    })
    expect(inferred).toEqual({
      status: 'available',
      quality: 'inferred',
      source: ['trace-archive:r1'],
      value: 'hello world'
    })

    // Truncated > 2 KiB becomes partial while preserving quality
    const longText = 'x'.repeat(3000)
    const truncated = buildTaskSummaryEvidence({
      status: 'available',
      quality: 'exact',
      source: ['trace-archive:r2'],
      value: longText
    })
    expect(truncated.status).toBe('partial')
    expect(truncated.quality).toBe('exact')
    expect(Buffer.byteLength(truncated.value ?? '', 'utf8')).toBeLessThanOrEqual(2048)

    // Empty final message -> unavailable(empty_final_message)
    const empty = buildTaskSummaryEvidence({
      status: 'available',
      quality: 'exact',
      source: ['trace-archive:r3'],
      value: '   '
    })
    expect(empty.status).toBe('unavailable')
    expect(empty.quality).toBe('unavailable')
    expect(empty.omissionReason).toBe('empty_final_message')
  })

  it('excludes agent-authored turns from user turn counts and marks missing authors partial (E2)', () => {
    const res = countUserTurnsWithAuthor([
      { runId: 'r1', author: 'user' },
      { runId: 'r2', author: 'agent' },
      { runId: 'r3', author: 'unavailable' },
      { runId: 'r4', author: null }
    ])
    expect(res).toEqual({
      userTurns: 1,
      excludedAgentTurns: 1,
      unavailableAuthorTurns: 2,
      status: 'partial'
    })
  })

  it('aggregates usage separately by unit and by quality without collapsing or zero-filling (E3)', () => {
    const agg = aggregateDelegatedUsage([
      { runId: 'c1', tokens: { status: 'available', quality: 'exact', value: 1200 }, usd: { status: 'available', quality: 'exact', value: 0.12 } },
      { runId: 'c2', tokens: { status: 'available', quality: 'estimated', value: 300 }, credits: { status: 'available', quality: 'inferred', value: 5 } },
      { runId: 'c3', tokens: { status: 'unavailable', quality: 'unavailable' } }
    ])
    expect(agg.status).toBe('partial')
    expect(agg.unavailableCount).toBe(1)
    expect(agg.tokens).toEqual({ exact: 1200, estimated: 300 })
    expect(agg.usd).toEqual({ exact: 0.12 })
    expect(agg.credits).toEqual({ inferred: 5 })
  })

  it('detects overlapping non-terminal intervals on the same canonical cwd (E4)', () => {
    const overlap = detectParallelWorkspaceOverlap(
      { runId: 'r1', cwd: '/repo', startedAt: 100, endedAt: 500 },
      [
        { runId: 'r1', cwd: '/repo', startedAt: 100, endedAt: 500 },
        { runId: 'r2', cwd: '/repo', startedAt: 300, endedAt: 600 },
        { runId: 'r3', cwd: '/other', startedAt: 200, endedAt: 400 }
      ]
    )
    expect(overlap).toEqual({
      overlapped: true,
      overlappingRunIds: ['r2'],
      attributionStatus: 'partial',
      attributionQuality: 'inferred',
      reason: 'parallel_workspace_runs'
    })

    const disjoint = detectParallelWorkspaceOverlap(
      { runId: 'r1', cwd: '/repo', startedAt: 100, endedAt: 200 },
      [{ runId: 'r2', cwd: '/repo', startedAt: 201, endedAt: 400 }]
    )
    expect(disjoint.overlapped).toBe(false)
  })
})
