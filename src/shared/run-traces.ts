import type { ActiveRun, TraceEvent } from './trace.js'
import type { AgentQuestionRequest, AgentStopState } from './runtime.js'

/**
 * 单个 run 的 live trace 订阅合同。
 *
 * 存在理由：legacy `agent:trace` / `agent:userQuestion` 只有一个焦点，且 renderer 的
 * `useAgentSession` 会在焦点为空时「认领」第一条到达的 run。多个会话视图同时存在时，
 * 子会话的事件绝不能混进那条通道，所以每个可见 run 走自己的有界流，用自己的回执。
 *
 * 硬规则：
 * - 订阅只影响渲染；不改变焦点、会话指针或 run 生命周期。
 * - 每个批次只由该订阅的唯一所有者确认一次，且必须在其 store 提交之后。
 * - 观测降级（背压超限）如实上报，要求用权威快照重新对齐；不把截断当完整。
 */
export const RUN_TRACE_CHANNEL = 'runTraces:event'

const MAX_SUBSCRIPTION_ID_LENGTH = 64

/** renderer 自己生成订阅 id：事件可能在 subscribe 回执之前到达，双方必须提前知道同一个 id。 */
export function isValidRunTraceSubscriptionId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= MAX_SUBSCRIPTION_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
}

/** run id 来自 main 自己的登记，不接受空白/超长/控制字符。 */
export function isValidRunTraceRunId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value)
}

/** 一次 scoped 投递的额度回执；generation 由 main 桥自己维护，用于隔离重订阅后的迟到确认。 */
export interface RunTraceReceipt {
  generation: number
  batchId: number
  bytes: number
}

export interface RunTraceBatch extends RunTraceReceipt {
  events: TraceEvent[]
}

/** TraceOutputBridge 健康快照的结构副本：shared 不依赖 main，两侧字段保持同一含义。 */
export interface RunTraceStreamHealth {
  /** 交付代数：快照栅栏或窗口重挂之后递增，用来隔离过期的事件、快照与确认。 */
  generation: number
  degraded: boolean
  skippedEvents: number
  bufferedEvents: number
  bufferedBytes: number
  inFlightBytes: number
  resyncRequired: boolean
}

export interface RunTraceSubscribeRequest {
  runId: string
  subscriptionId: string
}

export type RunTraceSubscribeResult =
  /** 已建立（或复用）订阅；run 是有界权威快照，不是提示。 */
  | { status: 'subscribed'; subscriptionId: string; run: ActiveRun; health: RunTraceStreamHealth }
  /** run 不在登记里，也没有可复用的收口快照：没有可看的 live 流。 */
  | { status: 'unavailable' }
  /** 已达「同时最多两个可见流」的上限；不是失败，但也不能假装有流。 */
  | { status: 'limit' }
  | { status: 'rejected' }

export type RunTraceResyncResult =
  /**
   * 权威快照已经对齐到 generation 这一代。resyncId 是确认凭据：只有把这个快照真正
   * 应用到视图的那一方，才能在提交之后用它向 main 确认并清除降级。
   */
  | { status: 'ok'; run: ActiveRun; resyncId: number; health: RunTraceStreamHealth }
  | { status: 'missing' }

interface RunTraceEventBase {
  subscriptionId: string
  /**
   * 这条事件属于哪一代交付。renderer 用它做快照栅栏：只有 generation 不小于所应用快照
   * 那一代的事件才允许叠加到快照之上，否则会把快照里已有的内容算两遍。
   */
  generation: number
}

/**
 * 一个订阅上的事件。全部带 subscriptionId：renderer 只把事件交给拥有该 id 的那个视图，
 * 未匹配 id 的批次不会被别的视图确认。
 */
export type RunTraceEvent =
  | (RunTraceEventBase & { kind: 'trace'; batch: RunTraceBatch })
  | (RunTraceEventBase & { kind: 'health'; health: RunTraceStreamHealth })
  | (RunTraceEventBase & { kind: 'question'; request: AgentQuestionRequest })
  | (RunTraceEventBase & { kind: 'questionClosed'; questionId: string; runId: string })
  | (RunTraceEventBase & { kind: 'stopState'; state: AgentStopState })
  /** run 已收口并离开登记；run 为 null 表示连快照都取不到，调用方只认权威分页。 */
  | (RunTraceEventBase & { kind: 'terminal'; run: ActiveRun | null; health: RunTraceStreamHealth })
