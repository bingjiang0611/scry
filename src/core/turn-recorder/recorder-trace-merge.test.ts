import { expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace.js'
import { dedupeTraceEvents } from './recorder-trace-merge.js'

it('deduplicates a repeated snapshot without collapsing a concurrent snapshot from another repository', () => {
  const first: TraceEvent = {
    id: 'first', runId: 'run', kind: 'harness', stage: 'turn_diff', ts: '2026-10-25T12:00:00Z',
    turnDiff: { version: 1, status: 'failed', reason: 'git_error', files: [], requestedRoot: '/repo/a',
      beforeAt: '2026-10-25T11:59:00Z', afterAt: '2026-10-25T12:00:00Z', captureMs: 5, cleanup: 'ok' }
  }
  const duplicate = { ...first, id: 'shadow' }
  const second: TraceEvent = { ...first, id: 'second', turnDiff: { ...first.turnDiff!, requestedRoot: '/repo/b' } }
  expect(dedupeTraceEvents([first, duplicate, second]).map(event => event.id)).toEqual(['first', 'second'])
})
