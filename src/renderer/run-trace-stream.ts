import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentQuestionRequest, AgentStopState } from '@shared/runtime'
import { applyTraceBatch } from './format'
import { mergeActiveRun, removePendingQuestion } from './hooks/useAgentSession-helpers'

/**
 * scoped live 流的纯合并逻辑：一个订阅只服务一个 run，所以这里不需要 legacy Turn 列表语义。
 *
 * 关键边界：
 * - 快照是权威基线；先到的 delta 不能因为快照晚到就被丢掉，也不能反过来覆盖快照里更完整的内容。
 * - 事件按到达顺序累计；同一 id 的重复事件由 applyTraceBatch 原地替换，不会重复追加。
 */
export interface RunTraceStreamState {
  run?: ActiveRun
  /** connecting = 已发起订阅、快照未到；此时不能把「还没数据」显示成「没有运行」。 */
  status: 'idle' | 'connecting' | 'live' | 'unavailable' | 'limit'
}

/** 当前视图要不要订阅：没有可见 run 就什么都不做，有 run 但没有 scoped 桥时必须如实报不可用。 */
export type RunTraceStreamPlan =
  | { kind: 'idle' }
  | { kind: 'unavailable' }
  | { kind: 'connect'; runId: string }

export function planRunTraceStream(runId: string | undefined, visible: boolean, hasBridge: boolean): RunTraceStreamPlan {
  if (!runId || !visible) return { kind: 'idle' }
  // main/preload/renderer 一起发布：这个 preload 没有 scoped 流就没有可看的输出，
  // 不能显示成「健康且空闲」，也不能退回轮询所有 activeRuns。
  if (!hasBridge) return { kind: 'unavailable' }
  return { kind: 'connect', runId }
}

/** 权威快照与本地已有 delta 合并：保留本地独有事件，交给快照决定其余字段。 */
export function mergeStreamSnapshot(current: ActiveRun | undefined, snapshot: ActiveRun): ActiveRun {
  if (!current || current.runId !== snapshot.runId) return snapshot
  return mergeActiveRun([current], snapshot)[0]
}

/**
 * 把一批 delta 应用到当前 run。没有基线时返回 undefined：宁可让调用方继续持有事件，
 * 也不要凭空拼一个不含既有证据的 run。
 */
export function applyStreamBatch(current: ActiveRun | undefined, events: TraceEvent[]): ActiveRun | undefined {
  if (!current || events.length === 0) return current
  const owned = events.filter((event) => event.runId === current.runId)
  if (owned.length === 0) return current
  return applyTraceBatch([current], owned, new Set())[0]
}

/** 提问归属：只有该 run 自己的问题进入视图。 */
export function applyStreamQuestion(current: ActiveRun | undefined, request: AgentQuestionRequest): ActiveRun | undefined {
  if (!current || current.runId !== request.runId) return current
  const pending = (current.pendingQuestions ?? []).filter((item) => item.questionId !== request.questionId)
  return { ...current, pendingQuestions: [...pending, request] }
}

export function applyStreamQuestionClosed(current: ActiveRun | undefined, runId: string, questionId: string): ActiveRun | undefined {
  if (!current || current.runId !== runId) return current
  return { ...current, pendingQuestions: removePendingQuestion(current.pendingQuestions ?? [], { runId, questionId }) }
}

export function applyStreamStopState(current: ActiveRun | undefined, state: AgentStopState): ActiveRun | undefined {
  if (!current || current.runId !== state.runId) return current
  return { ...current, stopState: state }
}

/** 终态合并：本地已到达的终端证据不能被一个更早的权威快照抹掉。 */
export function mergeStreamTerminal(current: ActiveRun | undefined, terminal: ActiveRun): ActiveRun {
  const merged = mergeStreamSnapshot(current, terminal)
  return { ...merged, done: true }
}
