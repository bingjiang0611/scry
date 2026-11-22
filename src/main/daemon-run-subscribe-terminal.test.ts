import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { RunCursor } from './daemon-run-cursor'
import { applySubscribeEventToRuntime, readSubscribeTraceOnce } from './daemon-run-subscribe'
import { RunWakes } from './daemon-run-wakes'
import { readDaemonArchivedRunTrace } from './daemon-subscribe-parse'
import { desktopReaderFixture, removeFixtureRoots } from './remote/desktop-host-reader.fixtures'
import { parseDesktopHostRead } from './remote/desktop-host-reader'
import { upsertTraceArchiveTurn } from './transcript-archive'
import { traceArchivePath } from './transcript-archive-paths'

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
    apply, flush
  })
  expect(apply).toHaveBeenCalledWith({ kind: 'snapshot', run: archive }, cursor)
  expect(archivedRunTrace).toHaveBeenCalledTimes(1)
  expect(flush).toHaveBeenCalledTimes(1)
})

it('takes a reconnected question and its conversation scope from one subscription reply', async () => {
  const cursor: RunCursor = {
    runId: 'run', lifecycle: 'dispatched', watch: 0, output: 0, pushed: [], askedQuestions: new Set(),
    answerIds: new Map(), resyncRequired: false, pumping: false, stopped: false, sawText: false, admitted: true
  }
  const scheduleTraceRead = vi.fn(async () => {})
  const syncQuestions = vi.fn(async () => {})
  await applySubscribeEventToRuntime({
    runs: new Map([[cursor.runId, cursor]]), wakes: new RunWakes(), cursorFor: () => cursor, send: vi.fn(),
    flushBridge: vi.fn(), scheduleTraceRead, syncQuestions
  }, {
    type: 'run.question_opened', stream: 'run', runId: 'run', at: 1, seq: 2, payload: {},
    runRow: {
      runId: 'run', isConversationRun: true, sessionKey: 'conversation', scope: 'local',
      origin: 'local', provider: 'codex', profile: null, cwd: '/fixture', promptPreview: null,
      lifecycle: 'dispatched', stopState: null, outputSeq: null, intentSeq: 1,
      settledAt: null, recoveredAt: null, outcome: null, revSeq: 2,
      questions: [{ runId: 'run', providerId: 'codex', questionId: 'q', questions: [] }]
    }
  })
  expect(scheduleTraceRead).not.toHaveBeenCalled()
  expect(cursor.scopedDelivery).toBe(true)
  expect(syncQuestions).toHaveBeenCalledWith(cursor, [expect.objectContaining({ questionId: 'q' })])
})

it('recovers the exact segmented run outside the history page and keeps live overlap deduplicated', async () => {
  const fixture = desktopReaderFixture()
  try {
    const { context, userDataDir } = fixture
    const runId = 'old-completed-run'
    const ts = '2026-10-01T00:00:00.000Z'
    const live: TraceEvent = { id: 'result', ts, runId, kind: 'harness', stage: 'result' }
    const archived = { ...live, text: 'archive representation of the same event' }
    const late: TraceEvent = {
      ...live, id: 'diff', stage: 'turn_diff',
      turnDiff: { version: 1, status: 'captured', files: [], beforeAt: ts, afterAt: ts, captureMs: 1, cleanup: 'ok' }
    }
    expect(upsertTraceArchiveTurn({
      cwd: context.cwd, sessionId: context.externalSessionId, providerId: 'codex', userDataDir,
      turn: { runId, providerTurnId: 'target-native-turn', agentProfileId: null,
        ts: Date.parse(ts), userText: 'older prompt', items: [archived, late], done: true }
    })).toBe(true)
    expect(fixture.archive(1)).toBe(true)
    expect(fixture.archive(2)).toBe(true)
    const read = vi.fn(async (request: Record<string, unknown>) => ({
      desktop: await fixture.read(parseDesktopHostRead(request.query))
    }))
    const cursor: RunCursor = {
      context, runId, lifecycle: 'settled', watch: 0, output: 0, pushed: [live], askedQuestions: new Set(),
      answerIds: new Map(), resyncRequired: false, pumping: false, stopped: false, sawText: false, scopedDelivery: false
    }
    const apply = vi.fn(() => true)
    await readSubscribeTraceOnce({
      cursor, runId, disposed: false, terminal: true,
      transport: {
        trace: async () => ({ kind: 'snapshot', run: null }),
        archivedRunTrace: input => readDaemonArchivedRunTrace(read, input)
      },
      apply, flush: vi.fn()
    })
    expect(apply).toHaveBeenCalledExactlyOnceWith({
      kind: 'snapshot', run: expect.objectContaining({ runId, items: [live, late], done: true })
    }, cursor)
    expect(read).toHaveBeenCalledExactlyOnceWith({
      op: 'desktop', query: { kind: 'trace', archive: true, context, runId, images: true, byteChunks: true }
    }, { replayable: true })
    const monolith = traceArchivePath(userDataDir, context.cwd, context.externalSessionId, 'codex')
    mkdirSync(dirname(monolith), { recursive: true })
    writeFileSync(monolith, 'broken unrelated legacy archive')
    await expect(fixture.read({ kind: 'history', context })).rejects.toThrow('history_profile_unavailable')
    await expect(readDaemonArchivedRunTrace(read, { context, runId })).resolves.toMatchObject({ runId, done: true })
    await expect(readDaemonArchivedRunTrace(read, { context: { ...context, agentProfileId: 'another-profile' }, runId }))
      .rejects.toThrow('history_profile_unavailable')
  } finally {
    removeFixtureRoots([fixture.root])
  }
})
