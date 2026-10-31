import { Buffer } from 'node:buffer'
import type { TraceEvent } from '../shared/trace'

/**
 * 序列化失败（循环引用、BigInt 等）时使用的保守回退大小。刻意取单批上限量级，
 * 保证这类事件绝不会被当成 0 字节而绕过任何限额。
 */
export const TRACE_EVENT_FALLBACK_BYTES = 1024 * 1024

// 同一个事件对象会在 push 与 sendBatch 两处被测量；按对象身份缓存，保证每个事件
// 只序列化一次。WeakMap 随事件对象一起回收，不额外驻留内存。
const byteSizeCache = new WeakMap<TraceEvent, number>()

/**
 * 事件的 JSON 序列化 UTF-8 字节数。它覆盖全部嵌套字段（input、turnDiff、
 * runtimeMetadata 等），并按 UTF-8 计量，因此非 ASCII 文本与大结构化载荷都算得进来。
 *
 * 诚实边界：这是 JSON 序列化后的字节数，不是 Electron structured clone 的确切线上字节数；
 * 它是本模块所有限额（单批 / high-water / 安全上限）唯一使用的计量口径，也只用于流控，
 * 不作为任何证据或用量字段展示。
 */
export function traceEventByteSize(event: TraceEvent): number {
  const cached = byteSizeCache.get(event)
  if (cached != null) return cached
  let bytes: number
  try {
    const serialized = JSON.stringify(event)
    bytes = typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : TRACE_EVENT_FALLBACK_BYTES
  } catch {
    bytes = TRACE_EVENT_FALLBACK_BYTES
  }
  byteSizeCache.set(event, bytes)
  return bytes
}

/** 一次 trace IPC 的载荷：事件按到达顺序排列，bytes 是这一批的 JSON UTF-8 字节数。 */
export interface TraceBatchReceipt {
  /** Changes whenever the renderer delivery state is reset, fencing stale acknowledgements. */
  generation: number
  /** Monotonic within one bridge instance; duplicate acknowledgements are ignored. */
  batchId: number
  bytes: number
}

export interface TraceBatch extends TraceBatchReceipt {
  events: TraceEvent[]
}

export interface TraceBacklogState {
  /** 交付代数：reset/fence 之后递增，用于隔离过期的确认与快照。 */
  generation: number
  /** live 视图是否已经落后于权威证据。归档与 runState 始终是完整的。 */
  degraded: boolean
  /** 因为超过安全上限而没有镜像到 live 视图的事件数。 */
  skippedEvents: number
  bufferedEvents: number
  bufferedBytes: number
  inFlightBytes: number
  /** 需要 renderer 用权威快照重新对齐 live 视图。 */
  resyncRequired: boolean
}

export interface TraceOutputBridgeOptions {
  canSend: () => boolean
  send: (payload: TraceBatch) => void
  /** live 视图降级或恢复时诚实上报；缺省表示调用方不关心健康状态。 */
  publishHealth?: (state: TraceBacklogState) => void
  flushMs?: number
  maxBatchEvents?: number
  maxBatchBytes?: number
  highWaterBytes?: number
  maxBufferBytes?: number
  /** 未交付事件条数上限。字节预算挡不住海量小事件积压。 */
  maxBufferEvents?: number
  schedule?: (fn: () => void, ms: number) => () => void
  warn?: (message: string, state: TraceBacklogState) => void
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

/**
 * trace 的有界 IPC 桥：与 TerminalOutputBridge 同构（合批 + 字节上限 + ACK 背压），
 * 但绝不重排、也绝不静默丢弃 canonical evidence。
 *
 * - 顺序：FIFO 缓冲，按到达顺序发送。
 * - 有界：单批受事件数与字节上限约束；在途字节到 high-water 就停发，等 renderer ACK。
 * - 事件驱动：被 high-water 或 canSend=false 挡住时不留任何定时器，因此丢失 ACK 只会
 *   停更，绝不会退化成常驻空转轮询。恢复只由 ack() / rendererReady() / 新 push 触发。
 *   定时器仅用于「有事件但还没攒满一批」的合批延迟，且每批最多一个。
 * - 过载：缓冲触到安全上限时只停止镜像最新事件（保持 live 视图是一个连续前缀），
 *   并把跳过条数如实报告；权威证据仍在 runState 与归档里。
 * - 恢复：积压排空后要求 renderer 用权威快照重新对齐，renderer 确认后才清除降级标记。
 * - 终态：flushAll() 无视 high-water 把剩余事件一次发完，保证收口后的 live 视图完整。
 */
export class TraceOutputBridge {
  private buffer: TraceEvent[] = []
  private bufferedBytes = 0
  private inFlightBytes = 0
  private readonly inFlightBatches = new Map<number, { generation: number; bytes: number; events: number }>()
  private deliveryGeneration = 0
  /** 最近一次快照栅栏时已经上报的缺口；确认这一代快照时只抵扣这一部分。 */
  private fencedSkipped: number | undefined
  private nextBatchId = 0
  private skippedEvents = 0
  private degraded = false
  private resyncRequired = false
  private cancelTimer: (() => void) | null = null
  private readonly flushMs: number
  private readonly maxBatchEvents: number
  private readonly maxBatchBytes: number
  private readonly highWaterBytes: number
  private readonly maxBufferBytes: number
  private readonly maxBufferEvents: number
  /** 已发出但未 ACK 的事件条数。 */
  private inFlightEvents = 0
  private readonly schedule: (fn: () => void, ms: number) => () => void

  constructor(private readonly options: TraceOutputBridgeOptions) {
    this.flushMs = options.flushMs ?? 50
    this.maxBatchEvents = options.maxBatchEvents ?? 512
    this.maxBatchBytes = options.maxBatchBytes ?? 1024 * 1024
    this.highWaterBytes = options.highWaterBytes ?? 8 * 1024 * 1024
    this.maxBufferBytes = options.maxBufferBytes ?? 32 * 1024 * 1024
    this.maxBufferEvents = options.maxBufferEvents ?? 20_000
    this.schedule = options.schedule ?? defaultSchedule
  }

  push(event: TraceEvent): void {
    const bytes = traceEventByteSize(event)
    const overBudget = this.bufferedBytes + this.inFlightBytes + bytes > this.maxBufferBytes ||
      this.buffer.length + this.inFlightEvents >= this.maxBufferEvents
    if (overBudget) {
      // 只放弃镜像最新事件：live 视图保持连续前缀，缺口条数如实上报。
      this.skippedEvents += 1
      if (!this.degraded) {
        this.degraded = true
        this.options.warn?.('live trace mirror degraded after IPC backlog exceeded safety limit', this.snapshot())
      }
      this.publishHealth()
      return
    }
    this.buffer.push(event)
    this.bufferedBytes += bytes
    if (this.bufferedBytes >= this.maxBatchBytes || this.buffer.length >= this.maxBatchEvents) {
      this.flush()
      return
    }
    // 已经被背压或不可发送挡住时不排合批定时器：那只会空转一次而永远发不出去。
    // 恢复由 ack() / rendererReady() 驱动。
    if (this.blocked() || this.cancelTimer) return
    this.cancelTimer = this.schedule(() => this.flush(), this.flushMs)
  }

  /** 是否已被明确挡住：没有 ACK 额度，或 renderer 当前不可接收。 */
  private blocked(): boolean {
    return this.inFlightBytes >= this.highWaterBytes || !this.options.canSend()
  }

  /**
   * 尽可能把缓冲排空；受 high-water 背压与 canSend 约束。
   * 返回后要么缓冲已空，要么已被明确挡住——两种情况都不需要留定时器重试，
   * 所以这里不会自我重排，避免丢失 ACK 之后变成常驻轮询。
   */
  flush(): void {
    this.clearTimer()
    this.deliver(false)
  }

  /** 终态收口：无视 high-water 把剩余事件全部发完，保证 turnDone 之前 live 视图不缺事件。 */
  flushAll(): void {
    this.clearTimer()
    this.deliver(true)
  }

  /** renderer 重新可接收（窗口就绪 / 重挂完成）：恢复投递，替代轮询等待。 */
  rendererReady(): void {
    this.flush()
  }

  ack(receipt: TraceBatchReceipt): boolean {
    if (
      !receipt || !Number.isSafeInteger(receipt.generation) || receipt.generation < 0 ||
      !Number.isSafeInteger(receipt.batchId) || receipt.batchId < 0 ||
      !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0 || receipt.bytes > this.maxBufferBytes
    ) throw new Error('trace 输出确认无效')
    const expected = this.inFlightBatches.get(receipt.batchId)
    // Renderer reloads reset the credit ledger. A late or duplicate acknowledgement must never
    // release credit belonging to a newer window/batch that happens to be in flight.
    if (!expected || expected.generation !== receipt.generation) return false
    if (expected.bytes !== receipt.bytes) throw new Error('trace 输出确认字节不匹配')
    this.inFlightBatches.delete(receipt.batchId)
    this.inFlightBytes = Math.max(0, this.inFlightBytes - expected.bytes)
    this.inFlightEvents = Math.max(0, this.inFlightEvents - expected.events)
    this.flush()
    if (this.buffer.length === 0 && this.inFlightBytes === 0 && this.degraded && !this.resyncRequired) {
      // 积压排空：要求 renderer 用权威快照对齐，之后才允许清除降级标记。
      this.resyncRequired = true
      this.publishHealth()
    }
    return true
  }

  /** 当前交付代数。每次快照栅栏与窗口重挂之后递增。 */
  get generation(): number {
    return this.deliveryGeneration
  }

  /** renderer 已用权威快照对齐 live 视图（legacy 通道：没有代数参数，清全部缺口）。 */
  resynchronized(): void {
    if (!this.degraded && !this.resyncRequired) return
    this.degraded = false
    this.resyncRequired = false
    this.skippedEvents = 0
    this.publishHealth()
  }

  /**
   * 权威快照即将替换 renderer 视图：丢掉这一代还没交付/在途的事件，并从新一代重新计数。
   *
   * 与 reset() 唯一的差别是**不要求** renderer 再做一次重对齐：快照本身就是对齐。
   * 之前记录的缺口也先留着，等这一代快照被真正提交并确认时才抵扣（见 confirmSnapshot）。
   */
  fenceForSnapshot(): number {
    this.discardDelivery()
    this.fencedSkipped = this.skippedEvents
    this.deliveryGeneration += 1
    return this.deliveryGeneration
  }

  /**
   * 拥有这个视图的 renderer 已经把第 generation 代的权威快照应用到视图。
   *
   * 只抵扣栅栏那一刻已经上报的缺口：快照之后又丢的事件属于新一代，必须继续如实上报，
   * 否则「已对齐」会把新的缺口一起抹掉。代数对不上说明这个确认已经过期，不能清除任何东西。
   */
  confirmSnapshot(generation: number): boolean {
    if (generation !== this.deliveryGeneration) return false
    const fenced = this.fencedSkipped
    this.fencedSkipped = undefined
    if (fenced == null) return false
    this.skippedEvents = Math.max(0, this.skippedEvents - fenced)
    // 快照之后新增的缺口仍然成立，并要求再对齐一次。
    this.degraded = this.skippedEvents > 0
    this.resyncRequired = this.skippedEvents > 0
    this.publishHealth()
    return true
  }

  /**
   * 窗口重挂或 renderer 重建：在途字节不再有人 ACK，必须清零否则永久堵塞。
   * 丢掉未交付的缓冲同样意味着 live 视图不再完整，所以一并要求用权威快照重新对齐。
   */
  reset(): void {
    const discarded = this.buffer.length > 0 || this.inFlightBytes > 0
    this.discardDelivery()
    this.fencedSkipped = undefined
    this.deliveryGeneration += 1
    if (this.degraded || discarded) {
      this.resyncRequired = true
      this.publishHealth()
    }
  }

  close(): void {
    this.discardDelivery()
    this.fencedSkipped = undefined
    this.deliveryGeneration += 1
    this.degraded = false
    this.resyncRequired = false
    this.skippedEvents = 0
  }

  snapshot(): TraceBacklogState {
    return {
      generation: this.deliveryGeneration,
      degraded: this.degraded,
      skippedEvents: this.skippedEvents,
      bufferedEvents: this.buffer.length,
      bufferedBytes: this.bufferedBytes,
      inFlightBytes: this.inFlightBytes,
      resyncRequired: this.resyncRequired
    }
  }

  /** 清掉这一代还没交付的缓冲与在途额度：它们要么已被快照覆盖，要么已无人确认。 */
  private discardDelivery(): void {
    this.clearTimer()
    this.buffer = []
    this.bufferedBytes = 0
    this.inFlightBytes = 0
    this.inFlightEvents = 0
    this.inFlightBatches.clear()
  }

  /** 连续发批直到缓冲排空或被背压/不可发送挡住。 */
  private deliver(ignoreHighWater: boolean): void {
    while (this.buffer.length > 0) {
      if (!this.sendBatch(ignoreHighWater)) break
    }
  }

  private sendBatch(ignoreHighWater: boolean): boolean {
    if (this.buffer.length === 0) return false
    if (!this.options.canSend()) return false
    if (!ignoreHighWater && this.inFlightBytes >= this.highWaterBytes) return false
    let bytes = 0
    let count = 0
    while (count < this.buffer.length && count < this.maxBatchEvents) {
      const eventBytes = traceEventByteSize(this.buffer[count])
      if (count > 0 && bytes + eventBytes > this.maxBatchBytes) break
      bytes += eventBytes
      count += 1
    }
    const events = this.buffer.splice(0, count)
    this.bufferedBytes = Math.max(0, this.bufferedBytes - bytes)
    this.inFlightBytes += bytes
    this.inFlightEvents += events.length
    const batchId = this.nextBatchId++
    this.inFlightBatches.set(batchId, { generation: this.deliveryGeneration, bytes, events: events.length })
    this.options.send({ events, bytes, generation: this.deliveryGeneration, batchId })
    return true
  }

  private clearTimer(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private publishHealth(): void {
    this.options.publishHealth?.(this.snapshot())
  }
}
