import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { flattenTraceItems, previewTraceItems, traceEventToOutputChunk } from './trace-output'

function model(stage: string, text: string): TraceEvent {
  return { id: `${stage}-${text}`, runId: 'run-1', ts: '2026-09-14T00:00:00.000Z', kind: 'model', stage, text }
}

describe('remote trace output', () => {
  it('forwards real streamed text_delta content', () => {
    expect(traceEventToOutputChunk(model('text_delta', 'SCRY'))).toEqual({ kind: 'output', text: 'SCRY' })
  })

  it('bounds preview projection before concatenation and retains real result kinds', () => {
    const events = Array.from({ length: 1_000 }, () => model('text_delta', 'x'.repeat(10_000)))
    events.push({ id: 'tool', runId: 'run-1', ts: '2026-09-14', kind: 'tool', stage: 'tool:Bash', toolUseId: 'use', tool: 'Bash', output: 'real result' })
    const preview = previewTraceItems(events)
    expect(preview.items).toHaveLength(2)
    expect(preview.items[0].text.length).toBeLessThanOrEqual(2_048)
    expect(preview.items[1]).toMatchObject({ kind: 'tool_result', text: 'real result' })
    expect(preview.truncated).toBe(true)
    expect(preview.items[0].truncated).toBe(true)
    expect(preview.items[1].truncated).toBe(false)
    expect(previewTraceItems([model('text_delta', 'x'.repeat(10_000))]).items[0].truncated).toBe(true)
    expect(previewTraceItems([model('text_delta', '中🙂')])).toEqual({ items: [{ kind: 'output', text: '中🙂', truncated: false }], truncated: false })
  })

  it('keeps captured-body truncation and external-body provenance', () => {
    const event = model('text_delta', 'inline preview')
    event.modelContent = { content: 'inline preview', encoding: 'utf8', savedBytes: 14, source: 'provider', sourceCompleteness: 'partial', redaction: 'unchanged', storage: 'truncated', reasons: ['field_budget'] }
    expect(previewTraceItems([event])).toMatchObject({ truncated: true, items: [{ truncated: true }] })
    event.modelContent = { ...event.modelContent, sourceCompleteness: 'complete', storage: 'complete', reasons: [], contentRef: { storage: 'recorder-content-v1', sha256: 'a'.repeat(64), bytes: 10_000, encoding: 'utf8' } }
    expect(previewTraceItems([event])).toMatchObject({ truncated: true, items: [{ text: 'inline preview', truncated: true }] })
  })

  it('keeps the genuine result-only fallback in a preview', () => {
    const result: TraceEvent = { id: 'result', runId: 'run-1', ts: '2026-09-14', kind: 'harness', stage: 'result', text: 'final answer' }
    expect(previewTraceItems([result]).items[0]).toMatchObject({ kind: 'output', text: 'final answer' })
    expect(previewTraceItems([{ ...result, isError: true }]).items).toEqual([])
  })

  it('coalesces streamed deltas into readable archived text', () => {
    expect(flattenTraceItems([
      model('text_delta', 'SCRY_'),
      model('text_delta', 'REMOTE_OK')
    ])).toEqual([{ kind: 'output', text: 'SCRY_REMOTE_OK' }])
  })
})
