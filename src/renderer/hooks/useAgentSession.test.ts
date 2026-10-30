import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentQuestionRequest } from '@shared/runtime'
import { applyTraceBatch, type Turn } from '../format'
import {
  beginOptimisticTurn,
  buildAgentStartRequest,
  clearSessionTurns,
  confirmOptimisticTurn,
  currentVisibleRunId,
  discardOptimisticTurn,
  markTurnDone,
  markTurnError,
  mergeActiveRun,
  parsedSessionTurns,
  removePendingQuestion,
  replayPendingQuestionDeltas,
  replayRunLifecycleDeltas,
  restoredRunRuntimeState,
  sessionTurnsWithActiveRun,
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
      attachments: [image],
      // 每次提交自带命令标识，主进程据此对重投去重。
      commandId: expect.stringMatching(/^cmd-[0-9a-f-]{36}$/)
    })
    expect(buildAgentStartRequest('   ', { agentId: 'claude', attachments: [image] })).toEqual({
      prompt: '',
      agentId: 'claude',
      attachments: [image],
      commandId: expect.stringMatching(/^cmd-[0-9a-f-]{36}$/)
    })
    // 调用方显式给出的 commandId 必须被保留：重试要落在同一张收据上。
    expect(buildAgentStartRequest('retry', { agentId: 'claude', commandId: 'cmd-keep-this-one' })?.commandId)
      .toBe('cmd-keep-this-one')
    // 两次提交是两条命令，不能共用同一个标识。
    expect(buildAgentStartRequest('a', {})?.commandId).not.toBe(buildAgentStartRequest('a', {})?.commandId)
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
