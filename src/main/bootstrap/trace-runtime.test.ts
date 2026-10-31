import { describe, expect, it } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { AgentQuestionRequest } from '../../shared/runtime'
import type { RunTraceEvent } from '../../shared/run-traces'
import type { RunControl } from './run-control'
import { createTraceRuntime } from './trace-runtime'

const control = (runId: string): RunControl => ({
  runId, providerId: 'claude', runtimeProvider: 'claude_sdk',
  interrupt: () => undefined, forceKill: () => undefined,
  stopBackgroundTask: async () => ({ status: 'unknown' } as never),
  steer: async () => ({ status: 'unknown' } as never),
  forceKillScope: () => undefined,
  getExternalSessionId: () => undefined,
  getProviderTurnId: () => undefined,
  canonicalLifecycle: false,
  adoptSession: () => undefined,
  cleanupProvisional: () => undefined,
  finalizeTurnDiff: async () => undefined,
  cancelTurnDiff: async () => undefined,
  settled: Promise.resolve(),
  runState: { runId, userText: runId, items: [], done: false }
} as unknown as RunControl)

const run = (runId: string, extra: Partial<ActiveRun> = {}): ActiveRun => ({
  runId, userText: runId, items: [], done: false, providerSettled: false, ...extra
})

const event = (runId: string, id: string): TraceEvent => ({
  id, ts: '2026-01-01T00:00:00.000Z', runId, kind: 'model', stage: 'text', text: id
})

function fixture() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const window = {
    isFocused: () => false,
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => { sent.push({ channel, payload }) } }
  } as unknown as BrowserWindow
  const runtime = createTraceRuntime({
    getWindow: () => window,
    rendererCanReceive: () => true,
    activeRunSessionKey: (state) => state.sessionId ?? state.runId,
    dockBadge: {
      markAttention: () => undefined,
      releaseQuestionAttention: () => undefined,
      view: () => undefined,
      snapshot: () => ({ sessions: [] })
    } as never,
    mainEventId: (prefix, runId) => `${prefix}-${runId}-1`
  })
  const legacyEvents = (): TraceEvent[] => sent.flatMap(({ channel, payload }) =>
    channel === 'agent:trace' ? (payload as { events: TraceEvent[] }).events : [])
  const scoped = (subscriptionId: string): RunTraceEvent[] => sent.flatMap(({ channel, payload }) =>
    channel === 'runTraces:event' && (payload as RunTraceEvent).subscriptionId === subscriptionId
      ? [payload as RunTraceEvent] : [])
  const scopedEvents = (subscriptionId: string): TraceEvent[] =>
    scoped(subscriptionId).flatMap((value) => value.kind === 'trace' ? value.batch.events : [])
  return { runtime, sent, legacyEvents, scoped, scopedEvents }
}

function twoViews(f: ReturnType<typeof fixture>) {
  // 主会话被聚焦但空闲（IDLE parent）；子会话以 focus:false 登记，和生产的 managed run 一样。
  f.runtime.runs.register(run('run-parent'), control('run-parent'))
  f.runtime.runs.register(run('run-child'), control('run-child'), { focus: false })
  const parent = f.runtime.runTraces.subscribe({ runId: 'run-parent', subscriptionId: 'sub-parent-1' })
  const child = f.runtime.runTraces.subscribe({ runId: 'run-child', subscriptionId: 'sub-child-1' })
  expect(parent.status).toBe('subscribed')
  expect(child.status).toBe('subscribed')
}

describe('run trace routing at the runtime seam', () => {
  it('keeps child events out of the legacy focus channel while the parent is idle', () => {
    const f = fixture()
    twoViews(f)
    f.runtime.publishTrace(event('run-child', 'child-1'))
    f.runtime.runTraces.rendererReady()
    expect(f.legacyEvents()).toEqual([])
    expect(f.scopedEvents('sub-child-1').map((item) => item.id)).toEqual(['child-1'])
    expect(f.scopedEvents('sub-parent-1')).toEqual([])

    // 父会话自己的事件仍然走 legacy 焦点通道，同时不会串到子视图。
    f.runtime.publishTrace(event('run-parent', 'parent-1'))
    f.runtime.flushTraceSend()
    f.runtime.runTraces.rendererReady()
    expect(f.legacyEvents().map((item) => item.id)).toEqual(['parent-1'])
    expect(f.scopedEvents('sub-parent-1').map((item) => item.id)).toEqual(['parent-1'])
    expect(f.scopedEvents('sub-child-1').map((item) => item.id)).toEqual(['child-1'])
  })

  it('delivers a child question only to the child stream, never to the legacy question channel', () => {
    const f = fixture()
    twoViews(f)
    const request: AgentQuestionRequest = { runId: 'run-child', questionId: 'q-1', providerId: 'claude', questions: [] }
    f.runtime.publishQuestionOpened(request)
    expect(f.sent.filter(({ channel }) => channel === 'agent:userQuestion')).toEqual([])
    expect(f.scoped('sub-child-1').map((value) => value.kind)).toEqual(['question'])
    expect(f.scoped('sub-parent-1')).toEqual([])
    // 会话目录仍收到紧凑的待处理提示（不是整份 transcript）。
    expect(f.sent.filter(({ channel }) => channel === 'agent:questionAttention')).toEqual([
      { channel: 'agent:questionAttention',
        payload: { runId: 'run-child', pendingCount: 1, permissionCount: 0, inputCount: 1 } }
    ])

    f.runtime.publishQuestionClosed('run-child', 'q-1')
    expect(f.sent.filter(({ channel }) => channel === 'agent:userQuestionClosed')).toEqual([])
    expect(f.scoped('sub-child-1').map((value) => value.kind)).toEqual(['question', 'questionClosed'])
  })

  it('does not touch the focus pointer or run lifecycle when a second view subscribes', () => {
    const f = fixture()
    twoViews(f)
    expect(f.runtime.runs.focusedState()?.runId).toBe('run-parent')
    f.runtime.runTraces.reset()
    expect(f.runtime.runTraces.subscriptionCount()).toBe(0)
    expect(f.runtime.runs.get('run-parent')).toBeDefined()
    expect(f.runtime.runs.get('run-child')).toBeDefined()
  })

  it('settles the stream before the run leaves the registry, keeping the snapshot readable', () => {
    const f = fixture()
    twoViews(f)
    f.runtime.publishTrace(event('run-child', 'child-1'))
    const childState = f.runtime.runs.get('run-child')!.state
    childState.done = true
    f.runtime.runTraces.settle('run-child')
    f.runtime.runs.remove('run-child')
    expect(f.scopedEvents('sub-child-1').map((item) => item.id)).toEqual(['child-1'])
    const terminal = f.scoped('sub-child-1').find((value) => value.kind === 'terminal')
    expect(terminal).toMatchObject({ kind: 'terminal', run: { runId: 'run-child', done: true } })
    expect(f.runtime.runTraces.resync('sub-child-1')).toMatchObject({ status: 'ok', run: { runId: 'run-child' } })
  })

  it('never buffers events for a run nobody is watching', () => {
    const f = fixture()
    f.runtime.runs.register(run('run-parent'), control('run-parent'))
    f.runtime.runs.register(run('run-child'), control('run-child'), { focus: false })
    f.runtime.publishTrace(event('run-child', 'child-1'))
    f.runtime.runTraces.rendererReady()
    expect(f.sent.filter(({ channel }) => channel === 'runTraces:event')).toEqual([])
    expect(f.legacyEvents()).toEqual([])
  })

  it('still delivers the terminal diff of the focused run after done=true', () => {
    const f = fixture()
    f.runtime.runs.register(run('run-parent'), control('run-parent'))
    f.runtime.runs.focus('run-parent')
    // 终态 enrichment（turn_diff / session_diff）在 done=true 之后才发布：这里必须是「仍在看」
    // 判定，而不是 isFocused，否则归档里有 diff 而当前 UI 永远收不到。
    f.runtime.runs.get('run-parent')!.state.done = true
    f.runtime.publishTrace(event('run-parent', 'turn-diff'))
    f.runtime.flushTraceSend()
    expect(f.legacyEvents().map((item) => item.id)).toEqual(['turn-diff'])
    expect(f.runtime.runs.isFocused('run-parent')).toBe(false)
    expect(f.runtime.runs.isViewed('run-parent')).toBe(true)
  })
})
