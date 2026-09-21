import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentQuestionRequest, AgentStopState } from '@shared/runtime'
import { applyTraceBatch, type Turn } from '../format'
import type { ParsedTurn } from '../env'
import { runStopStatus } from '../run-stop-status'
import {
  TRACE_LIVE_HEALTHY,
  applyStopState,
  beginOptimisticTurn,
  buildAgentStartRequest,
  clearSessionTurns,
  confirmOptimisticTurn,
  clearStopState,
  currentVisibleRunId,
  discardOptimisticTurn,
  markTurnDone,
  markTurnError,
  mergeActiveRun,
  mergeRecoveredRun,
  parsedSessionTurns,
  prependOlderSessionTurns,
  removePendingQuestion,
  replayPendingQuestionDeltas,
  replayRunLifecycleDeltas,
  restoredRunRuntimeState,
  resynchronizeLiveTrace,
  sessionBusy,
  sessionHistoryWindowOf,
  sessionTurnsWithActiveRun,
  traceLiveHealthOf,
  turnBlocksInput,
  upsertPendingQuestion,
  visibleTurnsBeforeReplacement
} from './useAgentSession'

const ev = (id: string, runId = 'r1'): TraceEvent => ({
  id,
  runId,
  ts: '',
  kind: 'model',
  stage: 'text',
  text: id
})

const image = {
  kind: 'image' as const,
  name: 'shot.png',
  mimeType: 'image/png' as const,
  dataBase64: 'aGVsbG8=',
  size: 5
}

const questionRequest = (runId: string, questionId: string): AgentQuestionRequest => ({
  runId,
  questionId,
  questions: [
    {
      question: '继续？',
      header: '确认',
      multiSelect: false,
      options: [
        { label: '继续', description: '继续执行' },
        { label: '停止', description: '不再执行' }
      ]
    }
  ]
})

describe('useAgentSession state reducers', () => {
  it('builds preload start payloads with selected runtime metadata intact', () => {
    expect(
      buildAgentStartRequest('  run probe  ', {
        cwd: '/repo',
        agentId: 'qoder',
        backend: 'local',
        runtimeProvider: 'qoder_cli',
        attachments: [image]
      })
    ).toEqual({
      prompt: 'run probe',
      cwd: '/repo',
      agentId: 'qoder',
      backend: 'local',
      runtimeProvider: 'qoder_cli',
      attachments: [image]
    })
    expect(buildAgentStartRequest('   ', { agentId: 'claude', attachments: [image] })).toEqual({
      prompt: '',
      agentId: 'claude',
      attachments: [image]
    })
    expect(buildAgentStartRequest('   ', { agentId: 'codex', runtimeProvider: 'codex_cli' })).toBeNull()
    expect(buildAgentStartRequest(' edited ', {
      agentId: 'qoder',
      expectedExternalSessionId: 'run-stopped',
      restartLastTurn: { replaceRunId: 'run-stopped' }
    })).toMatchObject({
      prompt: 'edited',
      expectedExternalSessionId: 'run-stopped',
      restartLastTurn: { replaceRunId: 'run-stopped' }
    })
  })

  it('成功启动编辑重发后只保留被替换轮次之前的可见历史', () => {
    const turns: Turn[] = [
      { runId: 'r1', userText: 'first', items: [], done: true },
      { runId: 'r2', userText: 'stopped', items: [], done: true }
    ]

    expect(visibleTurnsBeforeReplacement(turns, 'r2')).toEqual([turns[0]])
    expect(visibleTurnsBeforeReplacement(turns, 'missing')).toBe(turns)
    expect(visibleTurnsBeforeReplacement(turns, undefined)).toBe(turns)
  })

  it('先渲染待发送消息，再用 main 的真实 runId 无缝替换', () => {
    const request = { prompt: '立即显示', attachments: [image] }
    const initial: Turn[] = [{ runId: 'old', userText: '上一轮', items: [], done: true }]
    const optimistic = beginOptimisticTurn(initial, 'pending-1', request)

    expect(optimistic.at(-1)).toMatchObject({
      runId: 'pending-1',
      pendingStart: true,
      userText: '立即显示',
      attachments: [image]
    })
    expect(currentVisibleRunId(optimistic)).toBeNull()

    const confirmed = confirmOptimisticTurn(optimistic, 'pending-1', 'run-real', request)
    expect(confirmed.map((turn) => turn.runId)).toEqual(['old', 'run-real'])
    expect(confirmed.at(-1)?.pendingStart).toBeUndefined()
    expect(currentVisibleRunId(confirmed)).toBe('run-real')
    expect(discardOptimisticTurn(optimistic, 'pending-1')).toEqual(initial)
  })

  it('真实 trace 先到时合并待发送占位，不重复显示用户消息', () => {
    const request = { prompt: '立即显示', attachments: [image] }
    const optimistic = beginOptimisticTurn([], 'pending-1', request)
    const withEarlyTrace: Turn[] = [
      ...optimistic,
      { runId: 'run-real', userText: '', items: [ev('early', 'run-real')], done: false }
    ]

    const confirmed = confirmOptimisticTurn(withEarlyTrace, 'pending-1', 'run-real', request)
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]).toMatchObject({ runId: 'run-real', userText: '立即显示' })
    expect(confirmed[0].items).toEqual([ev('early', 'run-real')])
  })

  it('restores an active run and preserves locally buffered trace extras', () => {
    const restored: Turn = { runId: 'r1', userText: 'prompt', items: [ev('remote')], done: false }
    const prev: Turn[] = [
      { runId: 'r1', userText: 'prompt', attachments: [image], items: [ev('remote'), ev('local')], done: false }
    ]

    expect(mergeActiveRun([], restored)).toEqual([restored])
    expect(mergeActiveRun(prev, restored)[0].items.map((item) => item.id)).toEqual(['remote', 'local'])
    expect(mergeActiveRun(prev, restored)[0].attachments).toEqual([image])
  })

  it('流式更新只重建活跃 turn，保留其它 turn 的对象身份（AssistantTurn memo 跳过重渲染的前提）', () => {
    const older: Turn = { runId: 'r1', userText: '早前', items: [ev('a', 'r1')], done: true }
    const active: Turn = { runId: 'r2', userText: '进行中', items: [ev('b', 'r2')], done: false }
    const prev: Turn[] = [older, active]
    const next = mergeActiveRun(prev, { ...active, items: [ev('b', 'r2'), ev('c', 'r2')] })
    // 数组本身是新引用，但已完成的历史 turn 必须保持同一对象引用，否则 memo 会在每个流式 tick 重渲染整条历史。
    expect(next).not.toBe(prev)
    expect(next[0]).toBe(older)
    expect(next[1]).not.toBe(active)
    expect(next[1].items.map((e) => e.id)).toEqual(['b', 'c'])
  })

  it('does not let an older active snapshot undo coalesced local stream text', () => {
    const stale: Turn = { runId: 'r1', userText: 'prompt', items: [{ ...ev('stream'), text: 'a', thinking: '想' }], done: false }
    const local: Turn[] = [{
      runId: 'r1', userText: 'prompt',
      items: [{ ...ev('stream'), text: 'ab', thinking: '想法' }], done: false
    }]
    const merged = mergeActiveRun(local, stale)[0].items[0]
    expect(merged.text).toBe('ab')
    expect(merged.thinking).toBe('想法')

    const newer = mergeActiveRun(local, {
      ...stale,
      items: [{ ...ev('stream'), text: 'abc', thinking: '想法完成' }]
    })[0].items[0]
    expect(newer.text).toBe('abc')
    expect(newer.thinking).toBe('想法完成')
  })

  it('flushes trace batches before turnDone and marks the turn complete', () => {
    const turns = applyTraceBatch([], [ev('a')], new Set<string>())
    expect(markTurnDone(turns, 'r1', 'provider-turn-1')[0]).toMatchObject({
      done: true,
      providerTurnId: 'provider-turn-1',
      forkTurnId: 'provider-turn-1',
      items: [{ id: 'a' }]
    })
  })

  it('records turn errors with the hint used by the UI', () => {
    const turns: Turn[] = [{ runId: 'r1', userText: 'prompt', items: [], done: false }]
    expect(markTurnError(turns, { runId: 'r1', message: 'boom', hint: 'retry' })[0]).toMatchObject({
      done: true,
      error: 'boom',
      errorHint: 'retry'
    })
  })

  it('停止目标只取当前可见会话的未完成 run，后台完成事件不会改变它', () => {
    const visible: Turn[] = [{ runId: 'run-b', userText: 'B', items: [], done: false }]

    expect(currentVisibleRunId(visible)).toBe('run-b')
    expect(currentVisibleRunId(markTurnDone(visible, 'run-a'))).toBe('run-b')
    expect(currentVisibleRunId(markTurnDone(visible, 'run-b'))).toBeNull()
  })

  it('clearTurns drops residual events from runs that were cleared', () => {
    const cleared = new Set<string>()
    const next = clearSessionTurns([{ runId: 'r1', userText: 'old', items: [], done: false }], cleared)

    expect(next).toEqual([])
    expect(applyTraceBatch(next, [ev('late', 'r1'), ev('fresh', 'r2')], cleared).map((turn) => turn.runId)).toEqual(['r2'])
  })

  it('replaces the timeline with parsed history turns and preserves native boundaries', () => {
    const turns = parsedSessionTurns('s1', [
      {
        runId: 'archived-run',
        providerTurnId: 'provider-turn-archived',
        forkTurnId: 'fork-turn-archived',
        userText: 'hello',
        attachments: [image],
        items: [ev('a', 'archived')],
        done: true
      }
    ])

    expect(turns).toEqual([
      {
        runId: 'archived-run',
        providerTurnId: 'provider-turn-archived',
        forkTurnId: 'fork-turn-archived',
        userText: 'hello',
        attachments: [image],
        items: [ev('a', 'archived')],
        done: true
      }
    ])
  })

  it('restores the selected live run without duplicating its partial transcript turn', () => {
    const activeRun: ActiveRun = {
      runId: 'live-run',
      cwd: '/repo',
      externalSessionId: 's1',
      userText: 'current prompt',
      items: [ev('live', 'live-run')],
      done: false
    }
    const turns = sessionTurnsWithActiveRun(
      's1',
      [
        { userText: 'older prompt', items: [ev('old', 'archived')] },
        { userText: 'current prompt', items: [ev('partial', 'archived')] }
      ],
      activeRun
    )

    expect(turns.map((turn) => turn.runId)).toEqual(['s1-0', 'live-run'])
    expect(turns[1].items.map((item) => item.id)).toEqual(['live'])
  })

  it('keeps an interrupted archived turn when a resumed run uses the same prompt', () => {
    const activeRun: ActiveRun = {
      runId: 'resumed-run',
      cwd: '/repo',
      externalSessionId: 's1',
      userText: '继续',
      items: [ev('live', 'resumed-run')],
      done: false
    }
    const turns = sessionTurnsWithActiveRun(
      's1',
      [
        {
          runId: 'interrupted-run',
          userText: '继续',
          items: [ev('interrupted', 'interrupted-run')],
          done: true,
          error: 'Request interrupted by user'
        }
      ],
      activeRun
    )

    expect(turns.map((turn) => turn.runId)).toEqual(['interrupted-run', 'resumed-run'])
    expect(turns[0]).toMatchObject({ done: true, error: 'Request interrupted by user' })
  })

  it('deduplicates pending questions and rejects stale close events by run', () => {
    const question = questionRequest('r1', 'tool-1')
    const pending = upsertPendingQuestion(upsertPendingQuestion([], question), question)

    expect(pending).toHaveLength(1)
    expect(removePendingQuestion(pending, { runId: 'stale', questionId: 'tool-1' })).toEqual(pending)
    expect(removePendingQuestion(pending, { runId: 'r1', questionId: 'tool-1' })).toEqual([])
  })

  it('replays question events received while the active-run snapshot is loading', () => {
    const first = questionRequest('r1', 'tool-1')
    const openedAfterSnapshot = questionRequest('r1', 'tool-2')

    expect(
      replayPendingQuestionDeltas([first], [
        { kind: 'open', request: openedAfterSnapshot },
        { kind: 'closed', event: { runId: 'r1', questionId: 'tool-1' } }
      ])
    ).toEqual([openedAfterSnapshot])
    expect(
      replayPendingQuestionDeltas([first], [
        { kind: 'closed', event: { runId: 'r1', questionId: 'tool-1' } }
      ])
    ).toEqual([])
  })

  it('replays a terminal event that arrived while an active-run snapshot was loading', () => {
    const staleSnapshot: Turn[] = [{ runId: 'r1', userText: 'prompt', items: [], done: false }]

    expect(
      replayRunLifecycleDeltas(staleSnapshot, [{ kind: 'done', event: { runId: 'r1' } }])
    ).toEqual([{ runId: 'r1', userText: 'prompt', items: [], done: true }])
    expect(
      replayRunLifecycleDeltas(staleSnapshot, [
        { kind: 'error', event: { runId: 'r1', message: 'stopped late', hint: 'ignored elsewhere' } }
      ])
    ).toMatchObject([{ runId: 'r1', done: true, error: 'stopped late' }])
  })

  it.each([
    { kind: 'done' as const, event: { runId: 'r1' } },
    { kind: 'error' as const, event: { runId: 'r1', message: 'stopped late', hint: 'retry' } }
  ])('keeps $kind terminal when a question opens before history restoration resolves', (terminalDelta) => {
    const staleTurn: Turn[] = [{ runId: 'r1', userText: 'prompt', items: [], done: false }]
    const openedAfterSnapshot = questionRequest('r1', 'tool-1')
    const runtime = restoredRunRuntimeState(
      'r1',
      [],
      [{ kind: 'open', request: openedAfterSnapshot }],
      [terminalDelta]
    )
    const turns = replayRunLifecycleDeltas(staleTurn, [terminalDelta])

    expect(runtime).toEqual({ pendingQuestions: [], running: false })
    expect(turns[0]).toMatchObject({
      done: true,
      ...(terminalDelta.kind === 'error' ? { error: 'stopped late', errorHint: 'retry' } : {})
    })
  })
})

describe('stop lifecycle projection', () => {
  const stopState = (
    runId: string,
    phase: AgentStopState['phase'],
    updatedAt: string
  ): AgentStopState => ({
    runId,
    providerId: 'claude',
    runtimeProvider: 'claude_sdk',
    phase,
    requestedAt: '2024-01-01T00:00:00.000Z',
    updatedAt,
    ...(phase === 'no_safe_force_kill' ? { forceKillBlockReason: 'shared_transport' as const } : {}),
    providerSettled: phase === 'settled',
    window: { gracefulMs: 6000, forceKillMs: 4000 }
  })

  it('keeps the newest phase and drops the marker only when the Provider settles', () => {
    const requested = applyStopState({}, stopState('r1', 'interrupt_requested', '2024-01-01T00:00:01.000Z'))
    const escalated = applyStopState(requested, stopState('r1', 'force_kill_requested', '2024-01-01T00:00:07.000Z'))
    expect(escalated.r1.phase).toBe('force_kill_requested')
    // 乱序到达的旧快照不能把阶段退回去。
    const outOfOrder = applyStopState(escalated, stopState('r1', 'interrupt_requested', '2024-01-01T00:00:01.000Z'))
    expect(outOfOrder).toBe(escalated)
    expect(applyStopState(escalated, stopState('r1', 'settled', '2024-01-01T00:00:11.000Z'))).toEqual({})
    expect(clearStopState({}, 'r1')).toEqual({})
  })

  it('keeps the session busy through every stop phase, including provider_unsettled', () => {
    const inFlight: Turn = { runId: 'r1', userText: 'go', items: [], done: false }
    const finished: Turn = { runId: 'r1', userText: 'go', items: [], done: true }
    const failed: Turn = { runId: 'r1', userText: 'go', items: [], done: false, error: 'boom' }

    // 停止的任何阶段都不解除会话占用：main 的 admission 仍按 providerSettled 判断，
    // 未 settle 时同一会话的新一轮会被直接拒绝，所以必须继续排队而不是立刻发送。
    expect(turnBlocksInput(inFlight)).toBe(true)
    expect(sessionBusy([inFlight], { restoring: false, running: true })).toBe(true)
    expect(sessionBusy([inFlight], { restoring: false, running: false })).toBe(true)

    // 只有真实终态（done / error）才解除占用。
    expect(turnBlocksInput(finished)).toBe(false)
    expect(turnBlocksInput(failed)).toBe(false)
    expect(sessionBusy([finished], { restoring: false, running: false })).toBe(false)

    expect(sessionBusy([finished], { restoring: true, running: false })).toBe(true)
    expect(sessionBusy([], { restoring: false, running: true })).toBe(true)
    expect(sessionBusy([], { restoring: false, running: false })).toBe(false)
  })

  it('describes each stop phase without claiming termination', () => {
    expect(runStopStatus(undefined)).toMatchObject({ tone: 'running', label: '运行中' })
    expect(runStopStatus(stopState('r1', 'interrupt_requested', 'x'))).toMatchObject({
      tone: 'stopping',
      label: '停止中',
      providerSettled: false
    })
    const forced = runStopStatus(stopState('r1', 'force_kill_requested', 'x'))
    expect(forced.tone).toBe('stopping')
    expect(forced.hint).toContain('强制终止')
    const unsettled = runStopStatus(stopState('r1', 'provider_unsettled', 'x'))
    expect(unsettled.tone).toBe('unsettled')
    expect(unsettled.label).toBe('Provider 未确认终止')
    expect(unsettled.hint).toContain('可能还在后台运行')
    // 必须说明新消息只是入队，不会立刻开始——否则用户会以为可以马上发下一轮。
    expect(unsettled.hint).toContain('先进队列')
    expect(unsettled.providerSettled).toBe(false)
    const noSafeKill = runStopStatus(stopState('r1', 'no_safe_force_kill', 'x'))
    // 共享 transport 上没有安全硬杀：UI 不能说已经强制终止，必须说清为何没杀。
    expect(noSafeKill.tone).toBe('unsettled')
    expect(noSafeKill.label).toBe('Provider 未确认终止')
    expect(noSafeKill.hint).toContain('没有发出强制终止')
    expect(noSafeKill.hint).toContain('共用')
    expect(noSafeKill.hint).toContain('先进队列')
    expect(noSafeKill.providerSettled).toBe(false)
    expect(runStopStatus(stopState('r1', 'settled', 'x')).providerSettled).toBe(true)
  })
})


describe('paged session history projection', () => {
  const parsed = (from: number, count: number): ParsedTurn[] =>
    Array.from({ length: count }, (_unused, index) => ({
      userText: `turn ${from + index}`,
      items: [],
      done: true
    }))

  it('保持分页后合成 runId 全局唯一且按序号确定', () => {
    const newest = parsedSessionTurns('s1', parsed(80, 3), 80)
    const older = parsedSessionTurns('s1', parsed(77, 3), 77)
    expect(newest.map((turn) => turn.runId)).toEqual(['s1-80', 's1-81', 's1-82'])
    expect(older.map((turn) => turn.runId)).toEqual(['s1-77', 's1-78', 's1-79'])
    expect(new Set([...newest, ...older].map((turn) => turn.runId)).size).toBe(6)
  })

  it('从 main 的 page 建立窗口，缺省 page 视为完整历史', () => {
    expect(sessionHistoryWindowOf('s1', { turns: [], offset: 60, totalTurns: 100, hasOlder: true, completeness: 'partial' }, 40))
      .toEqual({ sessionId: 's1', offset: 60, totalTurns: 100, hasOlder: true, completeness: 'partial' })
    expect(sessionHistoryWindowOf('s1', null, 7))
      .toEqual({ sessionId: 's1', offset: 0, totalTurns: 7, hasOlder: false, completeness: 'complete' })
  })

  it('只拼接严格相邻的更早页并保持时间升序', () => {
    const window = sessionHistoryWindowOf('s1', { turns: [], offset: 40, totalTurns: 100, hasOlder: true, completeness: 'partial' }, 60)
    const prev = parsedSessionTurns('s1', parsed(40, 2), 40)
    const applied = prependOlderSessionTurns(prev, window, 's1', {
      turns: parsed(38, 2),
      offset: 38,
      totalTurns: 100,
      hasOlder: true,
      completeness: 'partial'
    })
    expect(applied?.turns.map((turn) => turn.runId)).toEqual(['s1-38', 's1-39', 's1-40', 's1-41'])
    expect(applied?.window).toEqual({ sessionId: 's1', offset: 38, totalTurns: 100, hasOlder: true, completeness: 'partial' })

    const complete = prependOlderSessionTurns(prev, { ...window, offset: 2 }, 's1', {
      turns: parsed(0, 2),
      offset: 0,
      totalTurns: 100,
      hasOlder: false,
      completeness: 'partial'
    })
    expect(complete?.window.completeness).toBe('complete')
    expect(complete?.window.hasOlder).toBe(false)
  })

  it('丢弃过期、错位或跨会话的更早页响应', () => {
    const window = sessionHistoryWindowOf('s1', { turns: [], offset: 40, totalTurns: 100, hasOlder: true, completeness: 'partial' }, 60)
    const older = { turns: parsed(38, 2), offset: 38, totalTurns: 100, hasOlder: true, completeness: 'partial' as const }
    expect(prependOlderSessionTurns([], null, 's1', older)).toBeNull()
    expect(prependOlderSessionTurns([], window, 's2', older)).toBeNull()
    // 会话总轮数变了说明历史已被重新加载，旧响应不能拼接。
    expect(prependOlderSessionTurns([], window, 's1', { ...older, totalTurns: 101 })).toBeNull()
    // 不相邻（缺口或重叠）都拒绝。
    expect(prependOlderSessionTurns([], window, 's1', { ...older, offset: 30 })).toBeNull()
    expect(prependOlderSessionTurns([], window, 's1', { ...older, turns: [] })).toBeNull()
  })
})


describe('live trace health projection', () => {
  it('projects only the honest display facts and keeps healthy as the default', () => {
    expect(TRACE_LIVE_HEALTHY).toEqual({ degraded: false, skippedEvents: 0 })
    expect(
      traceLiveHealthOf({
        degraded: true,
        skippedEvents: 37,
        bufferedEvents: 12,
        bufferedBytes: 4096,
        inFlightBytes: 2048,
        resyncRequired: true
      })
    ).toEqual({ degraded: true, skippedEvents: 37 })
    expect(
      traceLiveHealthOf({
        degraded: false,
        skippedEvents: 0,
        bufferedEvents: 0,
        bufferedBytes: 0,
        inFlightBytes: 0,
        resyncRequired: false
      })
    ).toEqual(TRACE_LIVE_HEALTHY)
  })
})


describe('late live trace recovery', () => {
  it.each(['done', 'error'])('preserves %s delivered while the snapshot request was in flight', async (terminal) => {
    const snapshot: ActiveRun = { runId: 'r1', userText: 'fixture', done: false, items: [ev('old')] }
    let resolve!: (run: ActiveRun) => void
    let turns: Turn[] = [{ ...snapshot, items: [...snapshot.items, ev('new')] }]
    let acks = 0
    const recovery = resynchronizeLiveTrace({
      activeRun: () => new Promise<ActiveRun>((done) => { resolve = done }),
      traceResynchronized: async () => { acks++ }
    }, (run) => { turns = mergeRecoveredRun(turns, run) })
    turns = terminal === 'done' ? markTurnDone(turns, 'r1', 'native-turn', 'fork-turn')
      : markTurnError(turns, { runId: 'r1', message: 'transport lost', hint: 'inspect first' })
    resolve(snapshot)
    expect(await recovery).toEqual({ aligned: true, acknowledged: true })
    expect(turns[0].done).toBe(true)
    expect(turns[0].items.map((item) => item.id)).toEqual(['old', 'new'])
    if (terminal === 'error') expect(turns[0]).toMatchObject({ error: 'transport lost', errorHint: 'inspect first' })
    else expect(turns[0]).toMatchObject({ providerTurnId: 'native-turn', forkTurnId: 'fork-turn' })
    expect(acks).toBe(1)
  })
})

describe('live trace resync acknowledgement', () => {
  const snapshot = (overrides: Partial<ActiveRun> = {}): ActiveRun => ({
    runId: 'r1',
    userText: 'go',
    items: [ev('recovered-1'), ev('recovered-2')],
    done: false,
    ...overrides
  })

  it('acknowledges only after an authoritative snapshot is applied', async () => {
    const applied: ActiveRun[] = []
    let acknowledged = 0
    const outcome = await resynchronizeLiveTrace(
      {
        focusedRunSnapshot: async () => snapshot(),
        activeRun: async () => null,
        traceResynchronized: async () => { acknowledged += 1; return true }
      },
      (run) => applied.push(run)
    )
    expect(outcome).toEqual({ aligned: true, acknowledged: true })
    expect(applied.map((run) => run.runId)).toEqual(['r1'])
    expect(acknowledged).toBe(1)
  })

  it('never acknowledges when no snapshot is available', async () => {
    let acknowledged = 0
    const applied: ActiveRun[] = []
    const outcome = await resynchronizeLiveTrace(
      {
        focusedRunSnapshot: async () => null,
        activeRun: async () => null,
        traceResynchronized: async () => { acknowledged += 1; return true }
      },
      (run) => applied.push(run)
    )
    // 没有权威快照就没有对齐证据：必须保持降级。
    expect(outcome).toEqual({ aligned: false, acknowledged: false })
    expect(acknowledged).toBe(0)
    expect(applied).toEqual([])
  })

  it('never acknowledges when the snapshot lookup fails', async () => {
    let acknowledged = 0
    const outcome = await resynchronizeLiveTrace(
      {
        focusedRunSnapshot: async () => { throw new Error('main 不可用') },
        activeRun: async () => null,
        traceResynchronized: async () => { acknowledged += 1; return true }
      },
      () => { throw new Error('不应该应用任何快照') }
    )
    expect(outcome).toEqual({ aligned: false, acknowledged: false })
    expect(acknowledged).toBe(0)
  })

  it('never acknowledges when the snapshot belongs to a cleared run', async () => {
    let acknowledged = 0
    const outcome = await resynchronizeLiveTrace(
      {
        focusedRunSnapshot: async () => snapshot({ runId: 'gone' }),
        activeRun: async () => null,
        traceResynchronized: async () => { acknowledged += 1; return true }
      },
      () => { throw new Error('不应该应用已清空 run 的快照') },
      (runId) => runId === 'gone'
    )
    expect(outcome).toEqual({ aligned: false, acknowledged: false })
    expect(acknowledged).toBe(0)
  })

  it('recovers terminal-state skipped events that activeRun can no longer return', async () => {
    const applied: ActiveRun[] = []
    let activeRunCalls = 0
    const outcome = await resynchronizeLiveTrace(
      {
        // done=true 的 run：activeRun 会返回 null，focusedRunSnapshot 仍给出权威事件序列。
        focusedRunSnapshot: async () => snapshot({ done: true }),
        activeRun: async () => { activeRunCalls += 1; return null },
        traceResynchronized: async () => true
      },
      (run) => applied.push(run)
    )
    expect(outcome.aligned).toBe(true)
    expect(applied[0].done).toBe(true)
    expect(applied[0].items.map((item) => item.id)).toEqual(['recovered-1', 'recovered-2'])
    expect(activeRunCalls).toBe(0)
  })

  it('falls back to activeRun on older preloads and stays degraded when it returns null', async () => {
    let acknowledged = 0
    const nullOutcome = await resynchronizeLiveTrace(
      { activeRun: async () => null, traceResynchronized: async () => { acknowledged += 1; return true } },
      () => { throw new Error('不应该应用 null 快照') }
    )
    expect(nullOutcome).toEqual({ aligned: false, acknowledged: false })
    expect(acknowledged).toBe(0)

    const applied: ActiveRun[] = []
    const okOutcome = await resynchronizeLiveTrace(
      { activeRun: async () => snapshot(), traceResynchronized: async () => { acknowledged += 1; return true } },
      (run) => applied.push(run)
    )
    expect(okOutcome).toEqual({ aligned: true, acknowledged: true })
    expect(applied).toHaveLength(1)
  })

  it('never reports acknowledged when the preload has no acknowledgement channel', async () => {
    const applied: ActiveRun[] = []
    const outcome = await resynchronizeLiveTrace(
      { focusedRunSnapshot: async () => snapshot(), activeRun: async () => null },
      (run) => applied.push(run)
    )
    // 没有确认口就没有确认：main 仍保留 resyncRequired，不能报 acknowledged。
    expect(outcome).toEqual({ aligned: true, acknowledged: false })
    expect(applied).toHaveLength(1)
  })

  it('reports alignment even when the acknowledgement itself fails', async () => {
    const applied: ActiveRun[] = []
    const outcome = await resynchronizeLiveTrace(
      {
        focusedRunSnapshot: async () => snapshot(),
        activeRun: async () => null,
        traceResynchronized: async () => { throw new Error('确认失败') }
      },
      (run) => applied.push(run)
    )
    // 对齐已经发生，但没确认成功：main 保持 resyncRequired，下次健康事件会再试。
    expect(outcome).toEqual({ aligned: true, acknowledged: false })
    expect(applied).toHaveLength(1)
  })
})
