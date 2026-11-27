import { available, partial, type Evidence, type TurnEndReason, type TurnTermination } from '../../shared/turn-record.js'
import type { TraceEvent } from '../../shared/trace.js'
import { TERMINAL_CLOCK_SKEW_MS } from './recorder-contracts.js'
import type { RecorderOpenTurnState as OpenTurnState } from './runtime-state.js'

function credibleAt(value: string | undefined, startedMs: number, ceilingMs: number): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || ms < startedMs || ms > ceilingMs) return undefined
  return new Date(ms).toISOString()
}

export function resolveTurnEnd(
  open: OpenTurnState,
  startedAt: string,
  transcript: { completedAt?: string },
  events: TraceEvent[],
  forced?: 'expired',
  forcedNote?: string
): { completedAt: string; termination: Evidence<TurnTermination> } {
  const startedMs = Date.parse(startedAt)
  const ceilingMs = Date.now() + TERMINAL_CLOCK_SKEW_MS
  const reason: TurnEndReason = open.endReason ?? forced ?? 'provider_terminal'
  const observedAt = open.closingAt ? { observedAt: open.closingAt } : {}
  const transcriptEnd = credibleAt(transcript.completedAt, startedMs, ceilingMs)
  if (transcriptEnd) {
    return {
      completedAt: transcriptEnd,
      termination: available({ reason, completedAtSource: 'provider_transcript', ...observedAt }, ['provider_transcript'])
    }
  }
  const lastActivity = events
    .map((event) => credibleAt(event.ts, startedMs, ceilingMs))
    .filter((value): value is string => !!value)
    .sort()
    .at(-1)
  const stopEnd = credibleAt(open.stopObservedAt, startedMs, ceilingMs)
  const workAfterStop = events.some((event) =>
    !(event.kind === 'hook' && event.stage === 'hook_delivery') &&
    credibleAt(event.ts, startedMs, ceilingMs) != null &&
    !!stopEnd && Date.parse(event.ts) > Date.parse(stopEnd)
  )
  if (stopEnd && !workAfterStop) {
    const completedAtSource = open.stopObservedAtSource ?? 'recorder_observed_terminal'
    return {
      completedAt: stopEnd,
      termination: available({ reason, completedAtSource, ...observedAt }, ['lifecycle_hooks'])
    }
  }
  const terminalEnd = credibleAt(open.terminalAt, startedMs, ceilingMs)
  if (terminalEnd) {
    const completedAtSource = open.terminalAtSource ?? 'provider_terminal_event'
    return {
      completedAt: terminalEnd,
      termination: available(
        { reason, completedAtSource, ...observedAt },
        ['lifecycle_hooks'],
        completedAtSource === 'provider_terminal_event' ? 'exact' : 'estimated'
      )
    }
  }
  if (lastActivity) {
    return {
      completedAt: lastActivity,
      termination: partial(
        { reason, completedAtSource: 'last_observed_activity', ...observedAt },
        ['lifecycle_hooks'],
        forcedNote
          ? `${forcedNote}; completedAt is the last observed activity and is a lower bound`
          : 'no terminal event was observed; completedAt is the last observed activity and is a lower bound',
        'estimated'
      )
    }
  }
  return {
    completedAt: startedAt,
    termination: partial(
      { reason, completedAtSource: 'turn_start', ...observedAt },
      ['recorder_open_turn'],
      forcedNote
        ? `${forcedNote}; no activity was observed either, so this turn has no known end time or duration`
        : 'no terminal event and no activity were observed, so this turn has no known end time or duration'
    )
  }
}
