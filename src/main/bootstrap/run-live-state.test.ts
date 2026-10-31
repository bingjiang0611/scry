import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAgentStartRequest } from '../../shared/runtime'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import { sanitizeToolEvents } from '../../core/turn-recorder/tool-content'
import { createAppSessionStore } from '../app-store'
import { DockBadgeState } from '../dock-badge'
import { SessionDiffBaselineRegistry } from '../session-diff'
import { createTraceRuntime } from './trace-runtime'
import { createLiveRunState } from './run-live-state'

const receipts = vi.hoisted(() => ({
  getPath: vi.fn<() => string>(),
  appendUsage: vi.fn(),
  recordTurn: vi.fn(() => true)
}))
// Only the I/O is gated: persistence still runs for real against the private userData dir, and
// the callback that consumes it is the production onPersisted. The latch is explicit so the test
// never guesses a microtask count.
const gate = vi.hoisted(() => {
  let release: () => void = () => { }
  let signal: () => void = () => { }
  const released = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { signal = resolve })
  return { released, started, release: () => release(), signal: () => signal() }
})
vi.mock('electron', () => ({ app: { getPath: receipts.getPath } }))
vi.mock('../usage-jsonl', () => ({ appendUsage: receipts.appendUsage }))
vi.mock('../db', () => ({ recordTurn: receipts.recordTurn }))
vi.mock('../trace-tool-content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../trace-tool-content')>()
  return {
    ...actual,
    persistTraceToolEvents: async (userDataDir: string, cwd: string, events: TraceEvent[], recorderRoot?: string) => {
      gate.signal()
      await gate.released
      return await actual.persistTraceToolEvents(userDataDir, cwd, events, recorderRoot)
    }
  }
})

const POLICY = { toolOutput: 'full' as const, toolContentFieldBytes: 8 * 1024, toolContentTurnBytes: 128 * 1024 }
const oracle = (run: ActiveRun): TraceEvent[] => sanitizeToolEvents(run.items, POLICY, 'live_renderer')
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
const contentRefStorage = (event: TraceEvent): string | undefined =>
  event.stage === 'tool_result' ? event.outputContent?.contentRef?.storage : event.inputContent?.contentRef?.storage

let userDataDir: string
beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'scry-live-binding-'))
  receipts.getPath.mockReturnValue(userDataDir)
  receipts.appendUsage.mockClear()
})
afterEach(async () => { await rm(userDataDir, { recursive: true, force: true }) })

const createState = async (runId = 'run-live-binding') => {
  const sessions = createAppSessionStore(userDataDir)
  return await createLiveRunState({
    options: {}, providerId: 'claude', runtimeProvider: 'claude_sdk',
    request: normalizeAgentStartRequest({ prompt: 'task', providerId: 'claude' }),
    cwd: undefined, catalogCwd: '', contextKey: 'context',
    codexHookTrust: [], openCodePluginTrust: undefined,
    managedRecorderEnabled: false, homeDir: userDataDir,
    createRunId: () => runId,
    llmNetworkConfiguration: { read: async () => undefined },
    sessionDiffBaselines: new SessionDiffBaselineRegistry(),
    appSessionStore: () => sessions,
    recordingBlockedSessions: new Map(), getWindow: () => null,
    publishTrace: () => { }, rendererCanReceive: () => false,
    mainEventId: (prefix, id) => `${prefix}-${id}`,
    LIVE_TOOL_CONTENT_POLICY: POLICY,
    recordingRecoveryHint: '', userDataDir, scopedSessionKey: (id) => id,
    isRemoteRun: false, deleteRunAttachments: () => { },
    sessionBaselineKey: (context, id) => `${context}:${id}`
  })
}
let seq = 0
const boundedRuntime = () => createTraceRuntime({
  getWindow: () => null,
  rendererCanReceive: () => false,
  activeRunSessionKey: () => null,
  dockBadge: new DockBadgeState(() => { }),
  mainEventId: (prefix, runId) => `${prefix}:${runId}:${++seq}`
})
const textDelta = (runId: string, id: string, text: string, messageId = 'm-1'): TraceEvent => ({
  id, ts: 'T', runId, kind: 'model', stage: 'text_delta', text, messageId
})
const noteEvent = (runId: string, id: string): TraceEvent => ({
  id, ts: 'T', runId, kind: 'harness', stage: 'note', text: 'separator'
})
const replaceStream = (runId: string, id: string, text: string, messageId = 'm-1'): TraceEvent => ({
  id, ts: 'T', runId, kind: 'model', stage: 'text', text, messageId,
  runtimeMetadata: { replacesStreamedText: true }
})
const toolResult = (runId: string, id: string, body: string): TraceEvent => ({
  id, ts: 'T', runId, kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: id, output: body
})

describe('live run identity', () => {
  it('attributes later usage to the native session published after startup', async () => {
    const state = await createState()
    expect(state.observedSessionId).toBeUndefined()
    state.observedSessionId = 'native-session-after-start'
    state.emit({
      id: 'result-live-binding', ts: new Date().toISOString(), runId: state.runId,
      kind: 'harness', stage: 'result', providerId: 'claude', runtimeProvider: 'claude_sdk'
    })
    await state.ingestion.idle()
    expect(receipts.appendUsage).toHaveBeenLastCalledWith(
      userDataDir,
      expect.objectContaining({ runId: state.runId, externalSessionId: 'native-session-after-start' }),
      expect.objectContaining({ id: 'result-live-binding' })
    )
  })

  it('relocates a persisted enrichment that lands after a splice while it was pending', async () => {
    const state = await createState('run-persist-splice')
    const runId = state.runId
    const trace = boundedRuntime()
    // The run starts with its own controls event; it stays first in every expectation below.
    const startupIds = state.runState.items.map((item) => item.id)
    expect(startupIds.length).toBeGreaterThan(0)
    let released = false
    try {
      // Two deltas of the same message, separated by a harness event, then the pending tool call.
      state.emit(textDelta(runId, 'd-1', 'a'))
      state.emit(noteEvent(runId, 'n-1'))
      state.emit(textDelta(runId, 'd-2', 'b'))
      state.emit(toolResult(runId, 't-1', 'raw body'))
      await gate.started
      const expected = [...startupIds, 'd-1', 'n-1', 'd-2', 't-1']
      expect(state.runState.items.map((item) => item.id)).toEqual(expected)
      const toolIndex = state.runState.items.findIndex((item) => item.id === 't-1')
      const warm = trace.boundedLiveRun(state.runState).items
      expect(warm.map((item) => item.id)).toEqual(expected)
      expect(asJson(warm)).toEqual(asJson(oracle(state.runState)))
      // The streamed text is replaced while persistence is still pending: both deltas collapse
      // into one, so the tool call really moves up by one index.
      state.emit(replaceStream(runId, 'd-3', 'ab'))
      const moved = [...startupIds, 'd-3', 'n-1', 't-1']
      expect(state.runState.items.map((item) => item.id)).toEqual(moved)
      const movedIndex = state.runState.items.findIndex((item) => item.id === 't-1')
      expect(movedIndex).toBe(toolIndex - 1)
      expect(trace.boundedLiveRun(state.runState).items.map((item) => item.id)).toEqual(moved)
      expect(asJson(trace.boundedLiveRun(state.runState).items)).toEqual(asJson(oracle(state.runState)))
      // Release the gated persistence: the production onPersisted finds the tool by id at its
      // new index and the durable reference becomes visible.
      released = true
      gate.release()
      await state.ingestion.idle()
      const enriched = state.runState.items.find((item) => item.id === 't-1')!
      expect(state.runState.items.indexOf(enriched)).toBe(movedIndex)
      expect(enriched).toMatchObject({ output: 'raw body' })
      expect(contentRefStorage(enriched)).toBe('recorder-content-v1')
      const after = trace.boundedLiveRun(state.runState).items
      expect(after.map((item) => item.id)).toEqual(moved)
      expect(contentRefStorage(after[movedIndex])).toBe('recorder-content-v1')
      expect(asJson(after)).toEqual(asJson(oracle(state.runState)))
    } finally {
      if (!released) gate.release()
      await state.ingestion.idle()
    }
  })
})
