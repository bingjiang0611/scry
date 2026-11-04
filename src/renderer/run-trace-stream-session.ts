import type { ActiveRun } from '@shared/trace'
import type {
  RunTraceEvent,
  RunTraceResyncResult,
  RunTraceSubscribeRequest,
  RunTraceSubscribeResult
} from '@shared/run-traces'
import type { TraceBatchReceipt } from './env'
import { TRACE_LIVE_HEALTHY, traceLiveHealthOf, type TraceLiveHealth } from './hooks/useAgentSession-helpers'
import {
  applyStreamBatch,
  applyStreamQuestion,
  applyStreamQuestionClosed,
  applyStreamStopState,
  mergeStreamSnapshot,
  mergeStreamTerminal,
  type RunTraceStreamState
} from './run-trace-stream'

/** preload 提供的 run 级流接口子集；测试用同一个形状的假实现。 */
export interface RunTraceStreamPort {
  subscribe: (request: RunTraceSubscribeRequest) => Promise<RunTraceSubscribeResult>
  unsubscribe: (subscriptionId: string) => Promise<boolean>
  ack: (subscriptionId: string, receipt: TraceBatchReceipt) => Promise<boolean>
  resync: (subscriptionId: string) => Promise<RunTraceResyncResult>
  confirmResync: (subscriptionId: string, resyncId: number) => Promise<boolean>
  onEvent: (cb: (event: RunTraceEvent) => void) => () => void
}

/**
 * 一次提交屏障之后才能交给 main 的凭据：批次额度与「这一代快照已提交」。
 * 两者都只在宿主真正提交了对应 state 之后才发送。
 */
export type RunTraceStreamCommit =
  | { kind: 'batch'; subscriptionId: string; receipt: TraceBatchReceipt }
  | { kind: 'resync'; subscriptionId: string; resyncId: number }

export interface RunTraceStreamSessionOptions {
  runId: string
  port: RunTraceStreamPort
  /** 测试可固定；生产由 renderer 生成，事件先到也不会认错 owner。 */
  subscriptionId?: string
  /** 状态变化（React setState）。 */
  publish: (state: RunTraceStreamState & { health: TraceLiveHealth }) => void
  /** 请求一次帧合并 flush；拿到快照之后才会被调用。 */
  requestFlush: () => void
  /** 同步 flush（终态必须立刻把队列应用掉：终态之后视图可能马上切走）。 */
  flushNow: () => void
  onTerminal: (run: ActiveRun | null) => void
  createSubscriptionId?: () => string
}

/**
 * 一个 run 的 live 流会话：状态机与 IPC 交互部分，与 React 无关，便于直接验证。
 *
 * 硬规则（与 main 的回执纪律一致）：
 * - 快照之前到达的**全部** scoped 事件（增量、提问、停止进度、终态）都按到达顺序排队，
 *   拿到权威快照后依序补上：既不丢，也不会让更早的运行中快照覆盖终态。
 * - 快照是一次栅栏：main 在交付代上做栅栏，只有 generation 不小于快照那一代的事件才允许
 *   叠加。栅栏之前的增量已经包含在快照里，重放会把同一段文字算两遍。
 * - 回执与重对齐确认都只在宿主 **React 提交之后** 交出一次。
 * - 重对齐串行执行；过期的回复不覆盖当前视图，也不确认。
 * - 终态先同步 flush 再合并终态快照；退订留给视图卸载/切换，
 *   这样收口之后才发布的终态证据仍能送达。
 */
export class RunTraceStreamSession {
  readonly subscriptionId: string
  private state: RunTraceStreamState & { health: TraceLiveHealth } = { status: 'connecting', health: TRACE_LIVE_HEALTHY }
  /** 按到达顺序保留的 scoped 事件；水合之后由 drain() 逐条应用。 */
  private queue: RunTraceEvent[] = []
  /** 等宿主提交的凭据（批次额度 + 重对齐确认）。 */
  private commits: RunTraceStreamCommit[] = []
  /** 已应用的权威快照所在交付代：更早的事件一律不叠加。 */
  private fenceGeneration = 0
  private hydrated = false
  private stopped = false
  private settled = false
  private resyncInFlight = false
  /** 本地请求序号：退订或更新的一次重对齐之后，旧回复自动作废。 */
  private resyncToken = 0
  private off?: () => void

  constructor(private readonly options: RunTraceStreamSessionOptions) {
    this.subscriptionId = options.subscriptionId ?? (options.createSubscriptionId ?? defaultSubscriptionId)()
  }

  start(): void {
    this.off = this.options.port.onEvent((event) => this.handle(event))
    void this.options.port
      .subscribe({ runId: this.options.runId, subscriptionId: this.subscriptionId })
      .then((result) => this.onSubscribed(result))
      .catch(() => this.update({ status: 'unavailable' }))
  }

  /** 帧合并 flush：按到达顺序应用排队事件，交出待确认项（由宿主在提交后归还）。 */
  drain(): RunTraceStreamCommit[] {
    if (!this.hydrated || this.stopped) return []
    const queued = this.queue
    this.queue = []
    if (queued.length > 0) this.applyAll(queued)
    const commits = this.commits
    this.commits = []
    return commits
  }

  /** 退订并停止接受事件；迟到的回复、回执与确认都不再命中任何东西。 */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.resyncToken += 1
    this.off?.()
    this.off = undefined
    this.queue = []
    this.commits = []
    void this.options.port.unsubscribe(this.subscriptionId).catch(() => undefined)
  }

  private onSubscribed(result: RunTraceSubscribeResult): void {
    if (this.stopped) {
      // 迟到的订阅回执：订阅已经不属于当前视图，立刻退订，别在 main 里留一个没人读的桥。
      if (result.status === 'subscribed') void this.options.port.unsubscribe(this.subscriptionId).catch(() => undefined)
      return
    }
    if (result.status !== 'subscribed') {
      // 没有可看的流：如实报告，让调用方读权威分页，而不是退回「轮询所有 run」。
      this.queue = []
      this.commits = []
      this.update({ status: result.status === 'limit' ? 'limit' : 'unavailable' })
      this.options.onTerminal(null)
      return
    }
    this.fenceGeneration = result.health.generation
    this.hydrated = true
    this.seed(result.run, { replace: false })
    // 快照本身已经是终态时 seed 会停在 idle：不要再把它改回「正在运行」。
    this.update({ status: this.settled ? 'idle' : 'live', health: traceLiveHealthOf(result.health) })
    // 水合前排队的事件（含提问/停止/终态）交给下一次提交屏障按顺序应用。
    if (this.queue.length > 0) this.options.requestFlush()
    // 复用的订阅可能已经带着缺口：那份快照正是对齐它用的。
    if (result.health.resyncRequired && !this.settled) this.requestResync()
  }

  private handle(event: RunTraceEvent): void {
    if (this.stopped || event.subscriptionId !== this.subscriptionId) return
    if (event.kind === 'health') {
      this.update({ health: traceLiveHealthOf(event.health) })
      // 正在重对齐时不叠加请求：那一次快照覆盖到它的栅栏为止，之后的新缺口会再发健康事件。
      if (event.health.resyncRequired && this.hydrated && !this.resyncInFlight) this.requestResync()
      return
    }
    this.queue.push(event)
    if (event.kind === 'trace') {
      this.commits.push({
        kind: 'batch',
        subscriptionId: this.subscriptionId,
        receipt: {
          generation: event.batch.generation,
          batchId: event.batch.batchId,
          bytes: event.batch.bytes
        }
      })
    }
    if (!this.hydrated) return
    // 终态必须同步应用：视图可能立刻切到权威分页，最后一批证据不能等下一帧。
    if (event.kind === 'terminal') this.options.flushNow()
    else this.options.requestFlush()
  }

  /** 按到达顺序把事件叠加到当前 run 上，一次提交只发布一次状态。 */
  private applyAll(events: RunTraceEvent[]): void {
    let run = this.state.run
    let terminal: Extract<RunTraceEvent, { kind: 'terminal' }> | undefined
    for (const event of events) {
      // 栅栏那一代之前的事件已经包含在快照里：重放会把同一段文字/同一个提问算两遍。
      if (event.generation < this.fenceGeneration) continue
      switch (event.kind) {
        case 'trace':
          run = applyStreamBatch(run, event.batch.events) ?? run
          break
        case 'question':
          run = applyStreamQuestion(run, event.request) ?? run
          break
        case 'questionClosed':
          run = applyStreamQuestionClosed(run, event.runId, event.questionId) ?? run
          break
        case 'stopState':
          run = applyStreamStopState(run, event.state) ?? run
          break
        case 'terminal':
          // 已经收口：迟到的第二个终态事件不能重复触发提交后的权威刷新。
          if (this.settled) break
          if (event.run) run = mergeStreamTerminal(run, event.run)
          terminal = event
          break
      }
    }
    const patch: Partial<RunTraceStreamState & { health: TraceLiveHealth }> = {}
    if (run !== this.state.run) patch.run = run
    if (terminal) {
      this.settled = true
      patch.status = 'idle'
      patch.health = traceLiveHealthOf(terminal.health)
    }
    if (Object.keys(patch).length > 0) this.update(patch)
    if (terminal) this.options.onTerminal(terminal.run)
  }

  /**
   * 权威快照成为新基线。done 的快照本身就是终态证据，不需要再等 terminal 事件。
   * 返回 false 表示这份快照没有被采纳（例如它比已经收到的终态更旧）。
   */
  private seed(snapshot: ActiveRun, options: { replace: boolean }): boolean {
    // 已经收口：更早的运行中快照不能把终态盖回「正在运行」。
    if (this.settled && snapshot.done !== true) return false
    const base = options.replace ? snapshot : mergeStreamSnapshot(this.state.run, snapshot)
    if (base.done === true && !this.settled) {
      this.settled = true
      this.update({ run: base, status: 'idle' })
      this.options.onTerminal(base)
      return true
    }
    this.update({ run: base })
    return true
  }

  private requestResync(): void {
    const token = ++this.resyncToken
    this.resyncInFlight = true
    void this.options.port
      .resync(this.subscriptionId)
      .then((result) => {
        if (this.stopped || token !== this.resyncToken) return
        this.resyncInFlight = false
        if (result.status !== 'ok') return
        this.applyResync(result)
      })
      .catch(() => {
        if (token === this.resyncToken) this.resyncInFlight = false
      })
  }

  private applyResync(result: Extract<RunTraceResyncResult, { status: 'ok' }>): void {
    const generation = result.health.generation
    // 更早的一代：这个回复已经被窗口重挂或更新的栅栏取代，不能覆盖当前视图，也不确认。
    if (generation < this.fenceGeneration) return
    this.fenceGeneration = generation
    // 栅栏之前的增量、提问与额度全部作废：它们要么已经在快照里，要么额度已随栅栏清零。
    this.queue = this.queue.filter((event) => event.generation >= generation)
    this.commits = this.commits.filter((commit) => commit.kind !== 'batch' || commit.receipt.generation >= generation)
    this.hydrated = true
    if (!this.seed(result.run, { replace: true })) {
      // 没有采纳这份快照就不确认：main 继续保留降级，下一次健康事件会再对齐。
      return
    }
    this.update({ health: traceLiveHealthOf(result.health) })
    this.commits.push({ kind: 'resync', subscriptionId: this.subscriptionId, resyncId: result.resyncId })
    // 走一次提交屏障：宿主真正提交这个快照之后才向 main 确认。
    this.options.requestFlush()
  }

  private update(patch: Partial<RunTraceStreamState & { health: TraceLiveHealth }>): void {
    if (this.stopped) return
    this.state = { ...this.state, ...patch }
    this.options.publish(this.state)
  }
}

function defaultSubscriptionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `sub-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}
