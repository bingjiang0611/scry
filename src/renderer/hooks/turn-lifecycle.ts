// Applying a run's terminal lifecycle (done / error) to the visible turns.

import { INTERRUPTED_TURN_NOTICE } from '@shared/turn-outcome-copy'
import type { Turn } from '../format'

export interface TurnDoneEvent {
  runId: string
  sessionId?: string
  providerTurnId?: string
  forkTurnId?: string
  /** Terminal status from main; older hosts omit it. */
  status?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
}

export interface TurnErrorEvent {
  runId: string
  message: string
  hint?: string
}

export type RunLifecycleDelta =
  | { kind: 'done'; event: TurnDoneEvent }
  | { kind: 'error'; event: TurnErrorEvent }

/**
 * A stop before the Provider produced anything leaves no model output, result or error, and
 * such a turn is never archived (round seven G2): without the notice a live interrupted turn
 * reads like an empty completed one. The restored-archive path shows the same notice.
 */
function interruptedHint(existing: string | undefined): string {
  return existing?.includes(INTERRUPTED_TURN_NOTICE) ? existing : [INTERRUPTED_TURN_NOTICE, existing].filter(Boolean).join('\n')
}

export const markTurnDone = (
  prev: Turn[], runId: string, providerTurnId?: string, forkTurnId?: string, status?: TurnDoneEvent['status']
): Turn[] =>
  prev.map((turn) => (turn.runId === runId ? {
    ...turn,
    done: true,
    ...(providerTurnId ? { providerTurnId } : {}),
    ...((forkTurnId ?? providerTurnId) ? { forkTurnId: forkTurnId ?? providerTurnId } : {}),
    ...(status === 'interrupted' ? { errorHint: interruptedHint(turn.errorHint) } : {})
  } : turn))

export const markTurnError = (prev: Turn[], event: TurnErrorEvent): Turn[] =>
  prev.map((turn) =>
    turn.runId === event.runId ? { ...turn, done: true, error: event.message, errorHint: event.hint } : turn
  )

export const replayRunLifecycleDeltas = (prev: Turn[], deltas: RunLifecycleDelta[]): Turn[] =>
  deltas.reduce(
    (turns, delta) => delta.kind === 'done'
      ? markTurnDone(turns, delta.event.runId, delta.event.providerTurnId, delta.event.forkTurnId, delta.event.status)
      : markTurnError(turns, delta.event),
    prev
  )
