import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { spanRowsFromItems } from './span-ledger'
import { ensureFailedTerminalResult } from './run-outcome'

const context = {
  runId: 'run-1',
  message: 'network exploded',
  providerId: 'codex' as const,
  runtimeProvider: 'codex_cli' as const,
  id: 'failure-1',
  ts: '2026-08-01T00:00:00.000Z'
}

describe('terminal run outcome', () => {
  it('synthesizes one failed result for an ordinary Error and makes the turn queryable', () => {
    const items: TraceEvent[] = []
    expect(ensureFailedTerminalResult(items, context).created).toBe(true)
    expect(items).toEqual([expect.objectContaining({
      id: 'failure-1', kind: 'harness', stage: 'result', isError: true, runtimeFailureStage: 'runtime'
    })])
    expect(spanRowsFromItems({ runId: 'run-1', items, nowMs: 1 }).spans).toHaveLength(1)
  })

  it('marks an existing result without losing usage and collapses duplicate terminal results', () => {
    const items: TraceEvent[] = [
      { id: 'tool', ts: '', runId: 'run-1', kind: 'tool', stage: 'tool:Bash' },
      { id: 'old-result', ts: '', runId: 'run-1', kind: 'harness', stage: 'result', tokensIn: 1 },
      { id: 'final-result', ts: '', runId: 'run-1', kind: 'harness', stage: 'result', tokensIn: 7, costUsd: 0.2 }
    ]
    const { terminal, corrections, created } = ensureFailedTerminalResult(items, context)
    expect(created).toBe(false)
    expect(terminal).toMatchObject({ id: 'final-result', isError: true, tokensIn: 7, costUsd: 0.2 })
    expect(items.filter((event) => event.kind === 'harness' && event.stage === 'result')).toHaveLength(1)
    expect(corrections).toEqual([
      expect.objectContaining({ id: 'old-result', stage: 'result_superseded' }),
      expect.objectContaining({ id: 'final-result', stage: 'result' })
    ])
  })
})
