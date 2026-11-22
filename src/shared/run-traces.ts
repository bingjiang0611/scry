import type { ActiveRun, TraceEvent } from './trace.js'
import type { AgentQuestionRequest, AgentStopState } from './runtime.js'

export const RUN_TRACE_CHANNEL = 'runTraces:event'

const MAX_SUBSCRIPTION_ID_LENGTH = 64

export function isValidRunTraceSubscriptionId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= MAX_SUBSCRIPTION_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
}

export function isValidRunTraceRunId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value)
}

export interface RunTraceReceipt {
  generation: number
  batchId: number
  bytes: number
}

export interface RunTraceBatch extends RunTraceReceipt {
  events: TraceEvent[]
}

export interface RunTraceStreamHealth {
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
  | { status: 'subscribed'; subscriptionId: string; run: ActiveRun; health: RunTraceStreamHealth }
  | { status: 'unavailable' }
  | { status: 'limit' }
  | { status: 'rejected' }

export type RunTraceResyncResult =
  | { status: 'ok'; run: ActiveRun; resyncId: number; health: RunTraceStreamHealth }
  | { status: 'missing' }

interface RunTraceEventBase {
  subscriptionId: string
  generation: number
}

export type RunTraceEvent =
  | (RunTraceEventBase & { kind: 'trace'; batch: RunTraceBatch })
  | (RunTraceEventBase & { kind: 'health'; health: RunTraceStreamHealth })
  | (RunTraceEventBase & { kind: 'question'; request: AgentQuestionRequest })
  | (RunTraceEventBase & { kind: 'questionClosed'; questionId: string; runId: string })
  | (RunTraceEventBase & { kind: 'stopState'; state: AgentStopState })
  | (RunTraceEventBase & { kind: 'terminal'; run: ActiveRun | null; health: RunTraceStreamHealth })
