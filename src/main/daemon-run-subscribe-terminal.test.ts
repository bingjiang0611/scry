import { expect, it, vi } from 'vitest'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { RunCursor } from './daemon-run-cursor'
import { readSubscribeTraceOnce } from './daemon-run-subscribe'

it('recovers archived evidence written after a result already reached the window', async () => {
  const context = { cwd: '/workspace', providerId: 'codex', externalSessionId: 'session' }
  const result: TraceEvent = { id: 'result', ts: '2026-11-21T00:00:00.000Z', runId: 'run', kind: 'harness', stage: 'result' }
  const lateDiff: TraceEvent = { ...result, id: 'diff', stage: 'turn_diff' }
  const cursor: RunCursor = {
    context, runId: 'run', lifecycle: 'settled', watch: 0, output: 0, pushed: [result], askedQuestions: new Set(),
    answerIds: new Map(), resyncRequired: false, pumping: false, stopped: false, sawText: false
  }
  const archive: ActiveRun = { ...context, providerId: 'codex', runId: 'run', userText: 'edit a file', items: [result, lateDiff], done: true }
  const archivedRunTrace = vi.fn(async () => archive)
  const apply = vi.fn(() => true)
  const flush = vi.fn()
  await readSubscribeTraceOnce({
    cursor, runId: cursor.runId, disposed: false, terminal: true,
    transport: { trace: async () => ({ kind: 'snapshot', run: null }), archivedRunTrace },
    apply, syncQuestions: async () => {}, flush
  })
  expect(apply).toHaveBeenCalledWith({ kind: 'snapshot', run: archive }, cursor)
  expect(archivedRunTrace).toHaveBeenCalledTimes(1)
  expect(flush).toHaveBeenCalledTimes(1)
})
