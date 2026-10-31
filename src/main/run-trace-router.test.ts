import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { AgentQuestionRequest, AgentStopState } from '../shared/runtime'
import type { RunTraceEvent } from '../shared/run-traces'
import { RunRegistry } from './run-registry'
import { MAX_SCOPED_RUN_STREAMS, RunTraceRouter } from './run-trace-router'
import type { RunControl } from './bootstrap/run-control'

const CONTROL: RunControl = { runId: 'run-main' } as unknown as RunControl

function runState(runId: string, extra: Partial<ActiveRun> = {}): ActiveRun {
  return { runId, providerId: 'claude', cwd: '/workspace', userText: runId, items: [], done: false, providerSettled: false, ...extra }
}

const event = (runId: string, id: string): TraceEvent => ({
  id, ts: new Date().toISOString(), runId, kind: 'model', stage: 'text'
})

interface Harness {
  router: RunTraceRouter
  runs: RunRegistry<ActiveRun, RunControl>
  sent: RunTraceEvent[]
  canSend: { value: boolean }
  timers: Array<() => void>
  add: (runId: string, extra?: Partial<ActiveRun>) => ActiveRun
  /** 手动驱动 bridge 的合批定时器，避免测试依赖真实计时。 */
  runTimers: () => void
  traceEvents: (subscriptionId: string) => TraceEvent[]
}

function harness(): Harness {
  const runs = new RunRegistry<ActiveRun, RunControl>()
  const sent: RunTraceEvent[] = []
  const canSend = { value: true }
  const timers: Array<() => void> = []
  const router = new RunTraceRouter({
    runs,
    boundedLiveRun: (run) => run,
    canSend: () => canSend.value,
    send: (value) => sent.push(value),
    schedule: (fn) => { timers.push(fn); return () => { const index = timers.indexOf(fn); if (index >= 0) timers.splice(index, 1) } }
  })
  return {
    router, runs, sent, canSend, timers,
    add: (runId, extra) => {
      const state = runState(runId, extra)
      runs.register(state, { ...CONTROL, runId } as RunControl)
      return state
    },
    runTimers: () => { for (const timer of timers.splice(0)) timer() },
    traceEvents: (subscriptionId) => sent.flatMap((value) =>
      value.kind === 'trace' && value.subscriptionId === subscriptionId ? value.batch.events : [])
  }
}

const subscribe = (h: Harness, runId: string, subscriptionId: string) =>
  h.router.subscribe({ runId, subscriptionId })

/** 最近一次上报的健康状态：健康事件是 renderer 唯一能看到的当前状态。 */
const latestHealth = (h: Harness) => {
  const value = h.sent.filter((item) => item.kind === 'health').at(-1)
  if (value?.kind !== 'health') throw new Error('expected a health event')
  return value.health
}

describe('run trace router', () => {
  it('tracks view demand after ownership changes, including idempotence, stale release and teardown', () => {
    const h = harness()
    h.add('run-main')
    const changes: Array<[string, boolean]> = []
    const router = new RunTraceRouter({
      runs: h.runs, boundedLiveRun: run => run, canSend: () => true, send: () => {},
      onDemandChange: (runId, demanded) => {
        expect(router.hasDemand(runId)).toBe(demanded)
        changes.push([runId, demanded])
      }
    })
    expect(router.hasDemand('run-main')).toBe(false)
    expect(router.subscribe({ runId: 'missing', subscriptionId: 'sub-main-1' }).status).toBe('unavailable')
    expect(router.subscribe({ runId: 'run-main', subscriptionId: 'sub-main-1' }).status).toBe('subscribed')
    expect(router.subscribe({ runId: 'run-main', subscriptionId: 'sub-main-1' }).status).toBe('subscribed')
    expect(router.unsubscribe('stale-sub')).toBe(false)
    expect(changes).toEqual([['run-main', true]])
    router.settle('run-main')
    expect(router.hasDemand('run-main')).toBe(true)
    router.unsubscribe('sub-main-1')
    router.subscribe({ runId: 'run-main', subscriptionId: 'sub-main-2' })
    expect(router.unsubscribe('sub-main-1')).toBe(false)
    expect(router.hasDemand('run-main')).toBe(true)
    router.close()
    expect(changes).toEqual([['run-main', true], ['run-main', false], ['run-main', true], ['run-main', false]])
  })

  it('combines legacy and scoped demand without allowing stale releases or resets to leak ownership', () => {
    const h = harness()
    h.add('run-main')
    h.add('run-child')
    const changes: Array<[string, boolean]> = []
    const router = new RunTraceRouter({
      runs: h.runs, boundedLiveRun: run => run, canSend: () => true, send: () => {},
      onDemandChange: (id, demand) => { expect(router.hasDemand(id)).toBe(demand); changes.push([id, demand]) }
    })
    router.setLegacyDemand('run-main', true)
    router.subscribe({ runId: 'run-main', subscriptionId: 'sub-main-1' })
    router.setLegacyDemand('run-child', true)
    expect(router.setLegacyDemand('run-main', false)).toBe(false)
    expect(router.hasDemand('run-main')).toBe(true)
    router.unsubscribe('sub-main-1')
    router.subscribe({ runId: 'run-child', subscriptionId: 'sub-child-1' })
    router.setLegacyDemand('run-child', false)
    expect(router.hasDemand('run-child')).toBe(true)
    router.reset()
    expect(changes).toEqual([['run-main', true], ['run-child', true], ['run-main', false], ['run-child', false]])
    router.setLegacyDemand('run-main', true)
    router.reset()
    expect(router.hasDemand('run-main')).toBe(false)
  })

  it('streams two runs independently and never mixes their events', () => {
    const h = harness()
    h.add('run-main')
    h.add('run-child')
    const main = subscribe(h, 'run-main', 'sub-main-1')
    const child = subscribe(h, 'run-child', 'sub-child-1')
    expect(main.status).toBe('subscribed')
    expect(child.status).toBe('subscribed')
    h.router.route(event('run-main', 'main-1'))
    h.router.route(event('run-child', 'child-1'))
    h.runTimers()
    expect(h.traceEvents('sub-main-1').map((item) => item.id)).toEqual(['main-1'])
    expect(h.traceEvents('sub-child-1').map((item) => item.id)).toEqual(['child-1'])
  })

  it('keeps the legacy focus pointer untouched: subscribing does not focus or adopt a run', () => {
    const h = harness()
    h.add('run-main')
    h.add('run-child')
    h.runs.focus('run-main')
    expect(subscribe(h, 'run-child', 'sub-child-1').status).toBe('subscribed')
    // IDLE 父会话不被顶替：子视图的订阅不是焦点动作，也不改会话指针。
    expect(h.runs.isFocused('run-child')).toBe(false)
    expect(h.runs.focusedState()?.runId).toBe('run-main')
  })

  it('refuses more than two visible streams and never builds a third bridge', () => {
    const h = harness()
    for (const runId of ['run-a', 'run-b', 'run-c']) h.add(runId)
    expect(subscribe(h, 'run-a', 'sub-a-001').status).toBe('subscribed')
    expect(subscribe(h, 'run-b', 'sub-b-001').status).toBe('subscribed')
    expect(subscribe(h, 'run-c', 'sub-c-001')).toEqual({ status: 'limit' })
    expect(h.router.subscriptionCount()).toBe(MAX_SCOPED_RUN_STREAMS)
  })

  it('rejects malformed or spoofed subscription payloads', () => {
    const h = harness()
    h.add('run-main')
    expect(h.router.subscribe(null)).toEqual({ status: 'rejected' })
    expect(h.router.subscribe({ runId: '', subscriptionId: 'sub-main-1' })).toEqual({ status: 'rejected' })
    expect(h.router.subscribe({ runId: 'run-main', subscriptionId: 'short' })).toEqual({ status: 'rejected' })
    expect(h.router.subscribe({ runId: 'run-main', subscriptionId: 'bad id with spaces' })).toEqual({ status: 'rejected' })
    // 未登记的 run 没有可看的流；不能凭空造一个。
    expect(subscribe(h, 'run-unknown', 'sub-unknown-1')).toEqual({ status: 'unavailable' })
    expect(h.router.subscriptionCount()).toBe(0)
  })

  it('is idempotent for the same run and rejects a reused id for another run', () => {
    const h = harness()
    h.add('run-main')
    h.add('run-child')
    const first = subscribe(h, 'run-main', 'sub-main-1')
    expect(subscribe(h, 'run-main', 'sub-main-1')).toMatchObject({ status: 'subscribed', subscriptionId: 'sub-main-1' })
    if (first.status !== 'subscribed') throw new Error('unexpected')
    // 同一个 id 指向另一个 run：拒绝，而不是把两条流搅在一起。
    expect(subscribe(h, 'run-child', 'sub-main-1')).toEqual({ status: 'rejected' })
    expect(h.router.subscriptionCount()).toBe(1)
  })

  it('confirms each batch once and ignores stale receipts after re-subscribe', () => {
    const h = harness()
    h.add('run-main')
    subscribe(h, 'run-main', 'sub-main-1')
    h.router.route(event('run-main', 'main-1'))
    h.runTimers()
    const batch = h.sent.find((value) => value.kind === 'trace')
    if (batch?.kind !== 'trace') throw new Error('expected a trace batch')
    expect(h.router.ack('sub-main-1', batch.batch)).toBe(true)
    // 同一批次重复确认：只生效一次，不能凭空放大额度。
    expect(h.router.ack('sub-main-1', batch.batch)).toBe(false)
    expect(h.router.unsubscribe('sub-main-1')).toBe(true)
    // 重订阅拿到新的桥：上一个订阅的迟到回执不能释放新订阅的额度。
    expect(subscribe(h, 'run-main', 'sub-main-2').status).toBe('subscribed')
    expect(h.router.ack('sub-main-1', batch.batch)).toBe(false)
    expect(h.router.ack('sub-main-2', batch.batch)).toBe(false)
  })

  it('cannot let a stale unsubscribe kill a newer subscription', () => {
    const h = harness()
    h.add('run-main')
    subscribe(h, 'run-main', 'sub-main-1')
    expect(h.router.unsubscribe('sub-main-1')).toBe(true)
    subscribe(h, 'run-main', 'sub-main-2')
    expect(h.router.unsubscribe('sub-main-1')).toBe(false)
    expect(h.router.subscriptionCount()).toBe(1)
    h.router.route(event('run-main', 'main-1'))
    h.runTimers()
    expect(h.traceEvents('sub-main-2').map((item) => item.id)).toEqual(['main-1'])
  })

  it('drops events for runs nobody is watching instead of buffering them', () => {
    const h = harness()
    h.add('run-main')
    h.add('run-child')
    subscribe(h, 'run-main', 'sub-main-1')
    h.router.route(event('run-child', 'child-1'))
    h.runTimers()
    expect(h.sent.filter((value) => value.kind === 'trace')).toHaveLength(0)
  })

  it('keeps degradation until the owning view confirms the snapshot it committed', () => {
    const h = harness()
    h.add('run-main')
    subscribe(h, 'run-main', 'sub-main-1')
    // renderer 不可接收：字节留在桥里，超过安全上限后只停止镜像最新事件并如实上报缺口。
    h.canSend.value = false
    for (let index = 0; index < 6_000; index++) h.router.route(event('run-main', `main-${index}`))
    expect(latestHealth(h).degraded).toBe(true)
    expect(latestHealth(h).skippedEvents).toBeGreaterThan(0)

    const resync = h.router.resync('sub-main-1')
    if (resync.status !== 'ok') throw new Error('expected a snapshot')
    // 快照只是取到了：renderer 还没提交，降级必须留着。
    expect(resync.resyncId).toBe(1)
    expect(resync.health.degraded).toBe(true)
    expect(latestHealth(h).degraded).toBe(true)

    expect(h.router.confirmResync('sub-main-1', resync.resyncId)).toBe(true)
    expect(latestHealth(h)).toMatchObject({ degraded: false, skippedEvents: 0 })
    expect(h.router.resync('sub-unknown-1')).toEqual({ status: 'missing' })
  })

  it('never clears a newer loss with an older resync confirmation', () => {
    const h = harness()
    h.add('run-main')
    subscribe(h, 'run-main', 'sub-main-1')
    h.canSend.value = false
    for (let index = 0; index < 6_000; index++) h.router.route(event('run-main', `main-${index}`))
    const first = h.router.resync('sub-main-1')
    const second = h.router.resync('sub-main-1')
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('expected snapshots')
    // 两次重对齐之间桥换了代：旧确认不能清掉新那一代记录的缺口。
    expect(second.resyncId).toBeGreaterThan(first.resyncId)
    expect(h.router.confirmResync('sub-main-1', first.resyncId)).toBe(false)
    expect(latestHealth(h).degraded).toBe(true)
    expect(h.router.confirmResync('sub-main-1', second.resyncId)).toBe(true)
    expect(latestHealth(h).degraded).toBe(false)
  })

  it('rejects unknown, foreign or already-unsubscribed resync confirmations', () => {
    const h = harness()
    h.add('run-main')
    subscribe(h, 'run-main', 'sub-main-1')
    h.canSend.value = false
    for (let index = 0; index < 6_000; index++) h.router.route(event('run-main', `main-${index}`))
    const resync = h.router.resync('sub-main-1')
    if (resync.status !== 'ok') throw new Error('expected a snapshot')
    expect(h.router.confirmResync('sub-unknown-1', resync.resyncId)).toBe(false)
    expect(h.router.confirmResync('sub-main-1', 99)).toBe(false)
    expect(h.router.confirmResync('sub-main-1', -1)).toBe(false)
    expect(h.router.confirmResync(null, resync.resyncId)).toBe(false)
    expect(latestHealth(h).degraded).toBe(true)
    // 视图已经退订：迟到的确认不能清掉任何东西。
    h.router.unsubscribe('sub-main-1')
    expect(h.router.confirmResync('sub-main-1', resync.resyncId)).toBe(false)
  })

  it('fences delivery at snapshot acquisition so buffered pre-snapshot events are not re-sent as deltas', () => {
    const h = harness()
    h.add('run-main')
    subscribe(h, 'run-main', 'sub-main-1')
    h.canSend.value = false
    h.router.route(event('run-main', 'pending-1'))
    const resync = h.router.resync('sub-main-1')
    if (resync.status !== 'ok') throw new Error('expected a snapshot')
    h.canSend.value = true
    h.router.rendererReady()
    // 栅栏之前缓冲的事件已经包含在快照里：不能再当成新的 delta 重发。
    expect(h.traceEvents('sub-main-1')).toEqual([])
    h.router.route(event('run-main', 'after-1'))
    h.runTimers()
    const batches = h.sent.filter((value) => value.kind === 'trace')
    expect(batches.flatMap((value) => value.kind === 'trace' ? value.batch.events.map((item) => item.id) : []))
      .toEqual(['after-1'])
    // 栅栏之后发出的批次带新一代编号，renderer 用它区分「快照之后」的事件。
    expect(batches.at(-1)).toMatchObject({ generation: resync.health.generation })
    expect(resync.health.generation).toBeGreaterThan(0)
  })

  it('delivers the initial race safely: events pushed before the renderer applied the snapshot stay ordered', () => {
    const h = harness()
    const state = h.add('run-main')
    state.items.push(event('run-main', 'before-subscribe'))
    const subscribed = subscribe(h, 'run-main', 'sub-main-1')
    if (subscribed.status !== 'subscribed') throw new Error('unexpected')
    // 快照里已经有那条事件；后续 delta 只有新的一条：两者可以按 id 合并，不会因为快照晚到而丢。
    expect(subscribed.run.items.map((item) => item.id)).toEqual(['before-subscribe'])
    h.router.route(event('run-main', 'after-subscribe'))
    h.runTimers()
    expect(h.traceEvents('sub-main-1').map((item) => item.id)).toEqual(['after-subscribe'])
  })

  it('flushes the final diff and keeps the stream readable after the run leaves the registry', () => {
    const h = harness()
    const state = h.add('run-main')
    subscribe(h, 'run-main', 'sub-main-1')
    // 收口前排队但还没到合批窗口的终态事件。
    h.router.route(event('run-main', 'turn-diff'))
    state.done = true
    h.router.settle('run-main')
    h.runs.remove('run-main')
    expect(h.traceEvents('sub-main-1').map((item) => item.id)).toEqual(['turn-diff'])
    const terminal = h.sent.find((value) => value.kind === 'terminal')
    if (terminal?.kind !== 'terminal') throw new Error('expected a terminal event')
    expect(terminal.run?.runId).toBe('run-main')
    // 迟到的 resync 仍能拿到收口快照，而不是 null。
    expect(h.router.resync('sub-main-1')).toMatchObject({ status: 'ok', run: { runId: 'run-main', done: true } })
    // 收口后重新订阅同一个 run 仍然可用（终态 diff 还可能在传）。
    expect(subscribe(h, 'run-main', 'sub-main-1')).toMatchObject({ status: 'subscribed' })
  })

  it('routes questions, closings and stop progress only to the owning subscription', () => {
    const h = harness()
    h.add('run-main')
    h.add('run-child')
    subscribe(h, 'run-main', 'sub-main-1')
    subscribe(h, 'run-child', 'sub-child-1')
    const request: AgentQuestionRequest = { runId: 'run-child', questionId: 'q-1', providerId: 'claude', questions: [] }
    h.router.publishQuestion(request)
    h.router.publishQuestionClosed('run-child', 'q-1')
    const requestedAt = new Date().toISOString()
    const stop: AgentStopState = {
      runId: 'run-child', providerId: 'claude', runtimeProvider: 'claude_sdk', phase: 'interrupt_requested',
      requestedAt, updatedAt: requestedAt, providerSettled: false,
      window: { gracefulMs: 5_000, forceKillMs: 10_000 }
    }
    h.router.publishStopState(stop)
    expect(h.sent.filter((value) => value.subscriptionId === 'sub-main-1')).toHaveLength(0)
    expect(h.sent.map((value) => value.kind)).toEqual(['question', 'questionClosed', 'stopState'])
  })

  it('stops one run without touching its sibling stream', () => {
    const h = harness()
    h.add('run-main')
    h.add('run-child')
    subscribe(h, 'run-main', 'sub-main-1')
    subscribe(h, 'run-child', 'sub-child-1')
    h.router.unsubscribe('sub-child-1')
    h.router.route(event('run-main', 'main-1'))
    h.runTimers()
    expect(h.traceEvents('sub-main-1').map((item) => item.id)).toEqual(['main-1'])
    expect(h.traceEvents('sub-child-1')).toEqual([])
    expect(h.runs.get('run-child')).toBeDefined()
  })

  it('tears every bridge down on renderer reset so a late receipt cannot leak into the next window', () => {
    const h = harness()
    h.add('run-main')
    subscribe(h, 'run-main', 'sub-main-1')
    h.router.route(event('run-main', 'main-1'))
    h.runTimers()
    h.canSend.value = false
    h.router.route(event('run-main', 'main-2'))
    h.router.reset()
    expect(h.router.subscriptionCount()).toBe(0)
    expect(h.timers).toHaveLength(0)
    expect(h.router.ack('sub-main-1', { generation: 0, batchId: 0, bytes: 1 })).toBe(false)
    expect(h.router.unsubscribe('sub-main-1')).toBe(false)
    expect(h.runs.get('run-main')).toBeDefined()
  })

  it('rejects an impossible receipt instead of quietly releasing credit', () => {
    const runs = new RunRegistry<ActiveRun, RunControl>()
    const router = new RunTraceRouter({
      runs, boundedLiveRun: (run) => run, canSend: () => true, send: () => { },
      schedule: () => () => { }
    })
    runs.register(runState('run-main'), { runId: 'run-main' } as RunControl)
    router.subscribe({ runId: 'run-main', subscriptionId: 'sub-main-1' })
    expect(() => router.ack('sub-main-1', { generation: -1, batchId: 0, bytes: 0 })).toThrow('trace 输出确认无效')
  })
})
