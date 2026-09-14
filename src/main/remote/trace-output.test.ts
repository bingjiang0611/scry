import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { flattenTraceItems, traceEventToOutputChunk } from './trace-output'

function model(stage: string, text: string): TraceEvent {
  return { id: `${stage}-${text}`, runId: 'run-1', ts: '2026-09-14T00:00:00.000Z', kind: 'model', stage, text }
}

describe('remote trace output', () => {
  it('forwards real streamed text_delta content', () => {
    expect(traceEventToOutputChunk(model('text_delta', 'SCRY'))).toEqual({ kind: 'output', text: 'SCRY' })
  })

  it('coalesces streamed deltas into readable archived text', () => {
    expect(flattenTraceItems([
      model('text_delta', 'SCRY_'),
      model('text_delta', 'REMOTE_OK')
    ])).toEqual([{ kind: 'output', text: 'SCRY_REMOTE_OK' }])
  })
})
