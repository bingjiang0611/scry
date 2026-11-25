import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentQuestionRequest, AgentStopState } from '@shared/runtime'
import { applyTraceBatch } from './format'
import { mergeActiveRun, removePendingQuestion } from './hooks/useAgentSession-helpers'

export interface RunTraceStreamState {
  run?: ActiveRun
  status: 'idle' | 'connecting' | 'live' | 'unavailable' | 'limit'
}

export type RunTraceStreamPlan =
  | { kind: 'idle' }
  | { kind: 'unavailable' }
  | { kind: 'connect'; runId: string }

export function planRunTraceStream(runId: string | undefined, visible: boolean, hasBridge: boolean): RunTraceStreamPlan {
  if (!runId || !visible) return { kind: 'idle' }
  if (!hasBridge) return { kind: 'unavailable' }
  return { kind: 'connect', runId }
}

export function mergeStreamSnapshot(current: ActiveRun | undefined, snapshot: ActiveRun): ActiveRun {
  if (!current || current.runId !== snapshot.runId) return snapshot
  return mergeActiveRun([current], snapshot)[0]
}

export function applyStreamBatch(current: ActiveRun | undefined, events: TraceEvent[]): ActiveRun | undefined {
  if (!current || events.length === 0) return current
  const owned = events.filter((event) => event.runId === current.runId)
  if (owned.length === 0) return current
  return applyTraceBatch([current], owned, new Set())[0]
}

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

export function mergeStreamTerminal(current: ActiveRun | undefined, terminal: ActiveRun): ActiveRun {
  const merged = mergeStreamSnapshot(current, terminal)
  return { ...merged, done: true }
}
