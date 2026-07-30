import { logicalCallEventsForTurn } from './logical-calls.js'
import type { TraceEvent } from './trace.js'
import type {
  EvidenceQuality,
  EvidenceStatus,
  TurnModelCallTiming,
  TurnModelTiming,
  TurnModelTimingLane
} from './turn-record.js'

export interface DerivedModelTiming {
  status: EvidenceStatus
  quality: EvidenceQuality
  value: TurnModelTiming
  omissionReason?: string
}

function finiteDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function timestampMs(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function intervalUnionMs(intervals: Array<{ startMs?: number; endMs?: number }>): number | undefined {
  const ordered = intervals
    .filter(
      (interval): interval is { startMs: number; endMs: number } =>
        interval.startMs != null &&
        interval.endMs != null &&
        interval.endMs >= interval.startMs
    )
    .map((interval) => [interval.startMs, interval.endMs] as const)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  if (ordered.length === 0) return undefined

  let total = 0
  let [start, end] = ordered[0]
  for (let index = 1; index < ordered.length; index++) {
    const [nextStart, nextEnd] = ordered[index]
    if (nextStart <= end) {
      end = Math.max(end, nextEnd)
      continue
    }
    total += end - start
    start = nextStart
    end = nextEnd
  }
  return total + end - start
}

function lane(calls: TurnModelCallTiming[]): TurnModelTimingLane {
  const durations = calls
    .map((call) => call.durationMs)
    .filter((duration): duration is number => duration != null)
  return {
    totalCalls: calls.length,
    timedCalls: durations.length,
    ...(durations.length > 0 ? { cumulativeMs: durations.reduce((sum, duration) => sum + duration, 0) } : {})
  }
}

function responseIntervalTiming(events: TraceEvent[]): DerivedModelTiming | undefined {
  const responses = events.filter(
    (event) => event.kind === 'model' && event.stage === 'response_completed'
  )
  if (responses.length === 0) return undefined

  const calls: TurnModelCallTiming[] = responses.map((event) => {
    const completedMs = timestampMs(event.ts)
    const durationMs = finiteDuration(event.durationMs)
    const startedMs =
      completedMs != null && durationMs != null && completedMs >= durationMs
        ? completedMs - durationMs
        : undefined
    return {
      ...(event.messageId ? { responseId: event.messageId } : {}),
      scope: event.agentId || event.parentToolUseId ? 'subagent' : 'root',
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
      ...(startedMs != null ? { startedAt: new Date(startedMs).toISOString() } : {}),
      completedAt: event.ts,
      ...(durationMs != null ? { durationMs } : {}),
      source: 'observed',
      boundary: 'turn_or_activity_end'
    }
  })
  const timedCalls = calls.filter((call) => call.durationMs != null && call.startedAt)
  const cumulativeMs = timedCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0)
  const occupiedMs = intervalUnionMs(timedCalls.map((call) => ({
    startMs: timestampMs(call.startedAt),
    endMs: timestampMs(call.completedAt)
  })))
  const root = lane(calls.filter((call) => call.scope === 'root'))
  const subagents = lane(calls.filter((call) => call.scope === 'subagent'))
  const complete = timedCalls.length === calls.length

  return {
    status: complete ? 'available' : 'partial',
    quality: 'estimated',
    value: {
      method: 'response_intervals',
      totalCalls: calls.length,
      timedCalls: timedCalls.length,
      ...(timedCalls.length > 0 ? { cumulativeMs } : {}),
      ...(occupiedMs != null
        ? {
            occupiedMs,
            overlapMs: Math.max(0, cumulativeMs - occupiedMs)
          }
        : {}),
      root,
      subagents,
      calls
    },
    ...(!complete ? { omissionReason: 'one or more model responses lacked a valid observed timing boundary' } : {})
  }
}

function providerApiTiming(events: TraceEvent[]): DerivedModelTiming | undefined {
  const results = events.filter(
    (event) =>
      event.kind === 'harness' &&
      event.stage === 'result' &&
      event.text !== 'transcript assistant usage'
  )
  const durations = results
    .map((event) => finiteDuration(event.durationApiMs))
    .filter((duration): duration is number => duration != null)
  if (durations.length === 0) return undefined
  return {
    status: 'available',
    quality: 'exact',
    value: {
      method: 'provider_api',
      cumulativeMs: durations.reduce((sum, duration) => sum + duration, 0)
    }
  }
}

function residualTiming(events: TraceEvent[]): DerivedModelTiming | undefined {
  const result = [...events].reverse().find(
    (event) =>
      event.kind === 'harness' &&
      event.stage === 'result' &&
      event.text !== 'transcript assistant usage' &&
      finiteDuration(event.durationMs) != null
  )
  const wallMs = finiteDuration(result?.durationMs)
  if (!result || wallMs == null) return undefined

  const resultByToolUseId = new Map<string, TraceEvent>()
  for (const event of events) {
    if (event.stage === 'tool_result' && event.toolUseId) resultByToolUseId.set(event.toolUseId, event)
  }
  const calls = logicalCallEventsForTurn(events).filter(
    (event) =>
      event.stage !== 'tool_result' &&
      (event.kind === 'tool' || event.kind === 'skill' || event.kind === 'agent')
  )
  const intervals = calls.map((event) => {
    const startMs = timestampMs(event.ts)
    const resultEvent = event.toolUseId ? resultByToolUseId.get(event.toolUseId) : undefined
    const resultMs = timestampMs(resultEvent?.ts)
    const nativeDuration = finiteDuration(resultEvent?.durationMs) ?? finiteDuration(event.durationMs)
    const endMs =
      resultMs != null && (startMs == null || resultMs >= startMs)
        ? resultMs
        : startMs != null && nativeDuration != null
          ? startMs + nativeDuration
          : undefined
    return { startMs, endMs }
  })
  const timedActivityCalls = intervals.filter(
    (interval) => interval.startMs != null && interval.endMs != null
  ).length
  const occupiedActivityMs = calls.length === 0 ? 0 : intervalUnionMs(intervals)
  if (occupiedActivityMs == null) return undefined

  return {
    status: 'partial',
    quality: 'estimated',
    value: {
      method: 'non_call_residual',
      cumulativeMs: Math.max(0, wallMs - occupiedActivityMs),
      occupiedMs: Math.max(0, wallMs - occupiedActivityMs),
      overlapMs: 0,
      activityCoverage: {
        timedCalls: timedActivityCalls,
        totalCalls: calls.length
      }
    },
    omissionReason: 'wall-clock remainder may include model, scheduling, hooks, IPC, and untimed activity'
  }
}

export function deriveModelTiming(events: TraceEvent[]): DerivedModelTiming | undefined {
  return providerApiTiming(events) ?? responseIntervalTiming(events) ?? residualTiming(events)
}
