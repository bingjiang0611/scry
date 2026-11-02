import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentStopState } from '@shared/runtime'
import type { Turn } from '../format'
import type { ParsedTurn } from '../env'
import { runStopStatus } from '../run-stop-status'
import {
  TRACE_LIVE_HEALTHY,
  applyStopState,
  clearStopState,
  markTurnDone,
  markTurnError,
  mergeRecoveredRun,
  parsedSessionTurns,
  prependOlderSessionTurns,
  resynchronizeLiveTrace,
  sessionBusy,
  sessionHistoryWindowOf,
  traceLiveHealthOf,
  turnBlocksInput
} from './useAgentSession'

const ev = (id: string, runId = 'r1'): TraceEvent => ({
  id,
  runId,
  ts: '',
  kind: 'model',
  stage: 'text',
  text: id
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
        generation: 3,
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
        generation: 0,
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
