import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentQuestionRequest } from '@shared/runtime'
import { applyTraceBatch, type Turn } from '../format'
import {
  buildAgentStartRequest,
  clearSessionTurns,
  currentVisibleRunId,
  markTurnDone,
  markTurnError,
  mergeActiveRun,
  parsedSessionTurns,
  removePendingQuestion,
  replayPendingQuestionDeltas,
  replayRunLifecycleDeltas,
  sessionTurnsWithActiveRun,
  upsertPendingQuestion
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

  it('flushes trace batches before turnDone and marks the turn complete', () => {
    const turns = applyTraceBatch([], [ev('a')], new Set<string>())
    expect(markTurnDone(turns, 'r1')[0]).toMatchObject({ done: true, items: [{ id: 'a' }] })
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

  it('replaces the timeline with parsed history turns', () => {
    const turns = parsedSessionTurns('s1', [
      { runId: 'archived-run', userText: 'hello', attachments: [image], items: [ev('a', 'archived')], done: true }
    ])

    expect(turns).toEqual([
      { runId: 'archived-run', userText: 'hello', attachments: [image], items: [ev('a', 'archived')], done: true }
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
})
