import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { AgentQuestionRequest, AgentStopState } from '../shared/runtime'
import {
  isValidRunTraceRunId,
  isValidRunTraceSubscriptionId,
  type RunTraceEvent,
  type RunTraceReceipt,
  type RunTraceResyncResult,
  type RunTraceStreamHealth,
  type RunTraceSubscribeResult
} from '../shared/run-traces'
import { TraceOutputBridge, type TraceBacklogState } from './trace-output'

/** 同时最多两个可见流：主会话 + 一个活动子会话。隐藏页签不订阅。 */
export const MAX_SCOPED_RUN_STREAMS = 2

/**
 * 单 run 的有界 buffer 上限。比 legacy 通道更紧：scoped 流只服务一个正在看的会话，
 * 一旦积压说明这个视图来不及提交，宁可停下并如实报告缺口，也不要撑大内存。
 */
const SCOPED_STREAM_LIMITS = {
  maxBatchEvents: 256,
  maxBatchBytes: 512 * 1024,
  highWaterBytes: 2 * 1024 * 1024,
  maxBufferBytes: 4 * 1024 * 1024,
  maxBufferEvents: 4_000
} as const

interface Subscription {
  id: string
  runId: string
  bridge: TraceOutputBridge
  /** 递增的重对齐编号：确认必须带最新那一个，过期的确认不能清掉后来那一代的缺口。 */
  resyncSeq: number
  /** 最近一次交付出去、还没被拥有者确认的快照。 */
  pendingResync?: { id: number; generation: number }
  /** 收口后 run 已离开登记：保留有界权威快照供晚到的重订阅/resync 读取。 */
  settledSnapshot?: ActiveRun
  settled: boolean
  closed: boolean
}

export interface RunTraceRouterDeps {
  /** 只读 run 登记；router 不登记、不聚焦、不移除任何 run。 */
  runs: { get: (runId: string) => { state: ActiveRun } | undefined }
  /** 有界 live 投影（与 activeRun / focusedRunSnapshot 同一口径）。 */
  boundedLiveRun: (run: ActiveRun) => ActiveRun
  canSend: () => boolean
  send: (event: RunTraceEvent) => void
  onDemandChange?: (runId: string, demanded: boolean) => void
  warn?: (message: string, detail: unknown) => void
  schedule?: (run: () => void, delayMs: number) => () => void
}

/**
 * run 级 live trace 路由：每个被订阅的 run 一条独立有界流，带自己的回执与健康状态。
 *
 * 与 legacy `TraceOutputBridge` 的关系是「同一个实现，不同的所有权」：这里不为路由另建
 * 一套 trace 系统，也不做第二份证据；权威事实仍在 runState 与归档里。
 *
 * 生命周期边界：
 * - 订阅/退订只是渲染动作，不停止、不聚焦、不改变 run 归属。
 * - 收口时先 flush 再发 terminal，订阅保持打开直到 renderer 主动退订，
 *   这样迟到的终态 diff 与 resync 仍然可读。
 * - renderer 重载（reset）会关闭全部桥并清空订阅，迟到的 ACK/退订不会命中新订阅。
 */
export class RunTraceRouter {
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly byRun = new Map<string, Subscription>()
  private legacyRunId: string | null = null

  constructor(private readonly deps: RunTraceRouterDeps) {}

  subscribe(request: unknown): RunTraceSubscribeResult {
    if (!request || typeof request !== 'object') return { status: 'rejected' }
    const { runId, subscriptionId } = request as { runId?: unknown; subscriptionId?: unknown }
    if (!isValidRunTraceRunId(runId) || !isValidRunTraceSubscriptionId(subscriptionId)) return { status: 'rejected' }
    const existing = this.byRun.get(runId)
    if (existing) {
      if (existing.id !== subscriptionId) return { status: 'rejected' }
      const run = this.snapshotOf(existing)
      return run
        ? { status: 'subscribed', subscriptionId: existing.id, run, health: this.healthOf(existing) }
        : { status: 'unavailable' }
    }
    const owner = this.subscriptions.get(subscriptionId)
    if (owner) return { status: 'rejected' }
    const state = this.deps.runs.get(runId)?.state
    if (!state) return { status: 'unavailable' }
    if (this.subscriptions.size >= MAX_SCOPED_RUN_STREAMS) return { status: 'limit' }
    const subscription: Subscription = {
      id: subscriptionId, runId, settled: false, closed: false, resyncSeq: 0,
      bridge: new TraceOutputBridge({
        canSend: this.deps.canSend,
        ...SCOPED_STREAM_LIMITS,
        flushMs: 16,
        ...(this.deps.schedule ? { schedule: this.deps.schedule } : {}),
        send: (payload) => this.emit(subscription, {
          kind: 'trace',
          subscriptionId: subscription.id,
          generation: payload.generation,
          batch: { events: payload.events, bytes: payload.bytes, generation: payload.generation, batchId: payload.batchId }
        }),
        // 降级必须让拥有这个视图的 renderer 看到：缺口不会被静默当成完整。
        publishHealth: (health) => this.emit(subscription, {
          kind: 'health', subscriptionId: subscription.id, generation: health.generation, health
        }),
        warn: (message, health) => this.deps.warn?.(message, { runId, health })
      })
    }
    this.subscriptions.set(subscription.id, subscription)
    this.byRun.set(runId, subscription)
    if (this.legacyRunId !== runId) this.deps.onDemandChange?.(runId, true)
    return {
      status: 'subscribed',
      subscriptionId: subscription.id,
      run: this.deps.boundedLiveRun(state),
      health: this.healthOf(subscription)
    }
  }

  unsubscribe(subscriptionId: unknown): boolean {
    if (typeof subscriptionId !== 'string') return false
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return false
    this.forget(subscription)
    return true
  }

  /** renderer 在其批量 state commit 之后归还额度。迟到/复用的回执由 bridge 的 generation 拦掉。 */
  ack(subscriptionId: unknown, receipt: RunTraceReceipt | undefined): boolean {
    if (typeof subscriptionId !== 'string' || !receipt) return false
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription || subscription.closed) return false
    return subscription.bridge.ack({
      generation: receipt.generation,
      batchId: receipt.batchId,
      bytes: receipt.bytes
    })
  }

  /**
   * 取一份权威快照，并**在交付代上做一次栅栏**：栅栏之前缓冲/在途的事件已经包含在快照里，
   * 不能再当作新的 delta 重发；栅栏之后的事件带新一代编号，可以叠加在快照之上。
   *
   * 降级标记不在这里清除：这只证明 main 交出了快照，还没证明拥有它的视图提交了。
   */
  resync(subscriptionId: unknown): RunTraceResyncResult {
    if (typeof subscriptionId !== 'string') return { status: 'missing' }
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return { status: 'missing' }
    const run = this.snapshotOf(subscription)
    if (!run) return { status: 'missing' }
    const resyncId = ++subscription.resyncSeq
    const generation = subscription.bridge.fenceForSnapshot()
    subscription.pendingResync = { id: resyncId, generation }
    return { status: 'ok', run, resyncId, health: this.healthOf(subscription) }
  }

  /**
   * 拥有这个视图的 renderer 已经把该快照提交进自己的 store：现在才允许清除降级。
   *
   * 只认最新那一次重对齐，而且必须还是同一代——窗口重挂或又一次栅栏之后，
   * 旧确认不能清掉新那一代记录的缺口。
   */
  confirmResync(subscriptionId: unknown, resyncId: unknown): boolean {
    if (typeof subscriptionId !== 'string' || !Number.isSafeInteger(resyncId)) return false
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription || subscription.closed) return false
    const pending = subscription.pendingResync
    if (!pending || pending.id !== resyncId || pending.generation !== subscription.bridge.generation) return false
    subscription.pendingResync = undefined
    return subscription.bridge.confirmSnapshot(pending.generation)
  }

  /** 追平该 run 的 live 事件；没有订阅就直接丢弃，绝不为没人看的 run 缓冲。 */
  route(event: TraceEvent): void {
    const subscription = this.byRun.get(event.runId)
    if (!subscription) return
    subscription.bridge.push(event)
  }

  publishQuestion(request: AgentQuestionRequest): void {
    const subscription = this.byRun.get(request.runId)
    if (!subscription) return
    this.emit(subscription, {
      kind: 'question', subscriptionId: subscription.id, generation: subscription.bridge.generation, request
    })
  }

  publishQuestionClosed(runId: string, questionId: string): void {
    const subscription = this.byRun.get(runId)
    if (!subscription) return
    this.emit(subscription, {
      kind: 'questionClosed', subscriptionId: subscription.id, generation: subscription.bridge.generation, runId, questionId
    })
  }

  publishStopState(state: AgentStopState): void {
    const subscription = this.byRun.get(state.runId)
    if (!subscription) return
    this.emit(subscription, {
      kind: 'stopState', subscriptionId: subscription.id, generation: subscription.bridge.generation, state
    })
  }

  /**
   * run 收口（registry 移除之前调用）：先终态 flush，再发 terminal。
   * 订阅不在这里关闭——终态 diff 与 resync 仍要能读到。
   */
  settle(runId: string): void {
    const subscription = this.byRun.get(runId)
    if (!subscription || subscription.settled) return
    subscription.settled = true
    subscription.settledSnapshot = this.snapshotOf(subscription)
    subscription.bridge.flushAll()
    this.emit(subscription, {
      kind: 'terminal',
      subscriptionId: subscription.id,
      generation: subscription.bridge.generation,
      run: subscription.settledSnapshot ?? null,
      health: this.healthOf(subscription)
    })
  }

  /** 窗口重挂/导航/崩溃：在途额度不会有人确认，全部作废并关闭；renderer 之后重新订阅。 */
  reset(): void {
    for (const subscription of [...this.subscriptions.values()]) this.forget(subscription)
    if (this.legacyRunId) this.setLegacyDemand(this.legacyRunId, false)
  }

  rendererReady(): void {
    for (const subscription of this.subscriptions.values()) subscription.bridge.rendererReady()
  }

  close(): void {
    this.reset()
  }

  /** 诊断用：当前活跃订阅数（上限 MAX_SCOPED_RUN_STREAMS）。 */
  subscriptionCount(): number {
    return this.subscriptions.size
  }

  hasDemand(runId: string): boolean {
    return this.byRun.has(runId) || this.legacyRunId === runId
  }

  /** One legacy pane in the trusted renderer. A stale release cannot clear its replacement. */
  setLegacyDemand(runId: string, demanded: boolean): boolean {
    const previous = this.legacyRunId
    if (!demanded && previous !== runId) return false
    const next = demanded ? runId : null
    if (previous === next) return true
    this.legacyRunId = next
    if (previous && !this.byRun.has(previous)) this.deps.onDemandChange?.(previous, false)
    if (next && !this.byRun.has(next)) this.deps.onDemandChange?.(next, true)
    return true
  }

  private forget(subscription: Subscription): void {
    if (subscription.closed) return
    subscription.closed = true
    subscription.bridge.close()
    this.subscriptions.delete(subscription.id)
    if (this.byRun.get(subscription.runId) === subscription) {
      this.byRun.delete(subscription.runId)
      if (this.legacyRunId !== subscription.runId) this.deps.onDemandChange?.(subscription.runId, false)
    }
  }

  private snapshotOf(subscription: Subscription): ActiveRun | undefined {
    const state = this.deps.runs.get(subscription.runId)?.state
    if (state) return this.deps.boundedLiveRun(state)
    return subscription.settledSnapshot
  }

  private healthOf(subscription: Subscription): RunTraceStreamHealth {
    const state: TraceBacklogState = subscription.bridge.snapshot()
    return {
      generation: state.generation,
      degraded: state.degraded,
      skippedEvents: state.skippedEvents,
      bufferedEvents: state.bufferedEvents,
      bufferedBytes: state.bufferedBytes,
      inFlightBytes: state.inFlightBytes,
      resyncRequired: state.resyncRequired
    }
  }

  private emit(subscription: Subscription, event: RunTraceEvent): void {
    if (subscription.closed) return
    this.deps.send(event)
  }
}
