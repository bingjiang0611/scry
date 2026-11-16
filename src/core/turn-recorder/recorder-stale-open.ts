import type { AgentTurnRecord, TurnEndReason } from '../../shared/turn-record.js'
import type { TranscriptRead } from './recorder-contracts.js'
import { hostProcessState } from './host-process.js'
import { openTurnQuiet, STALE_OPEN_TURN_QUIET_MS, type RecorderOpenTurnState } from './runtime-state.js'

/**
 * The stop reasons that mean the model finished replying. `tool_use` means it is waiting for a
 * result, and an unknown value proves nothing: both keep the turn open.
 */
const FINISHED_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'complete', 'completed', 'stop'])

export interface StaleOpenTurnVerdict {
  status: Extract<AgentTurnRecord['status'], 'completed' | 'interrupted'>
  /** Recorder-observed moment the evidence was taken, never the turn's own end time. */
  at: string
  endReason: TurnEndReason
  /** Named in every degraded evidence section, so the record says why it was closed this way. */
  reason: string
}

/**
 * Decide whether an open turn that never received a terminal event may be closed, and on what
 * evidence.
 *
 * Silence is not evidence by itself: a long tool, an approval wait or a Provider that is merely slow
 * all look exactly like a host that died. Two things break the tie —
 *
 * 1. the Provider's own transcript says its last reply finished (`stop_reason` other than `tool_use`)
 *    and nothing has been written for the quiet window. The turn's work is over; only its Stop hook
 *    was lost. Published as `completed` with an estimated end time, because the end is the last row
 *    we can see, not the moment the host reported.
 * 2. an operator asserts the process is gone (`expireOpen`), which is the only honest source for a
 *    session that died before producing anything to read. Even then the pass refuses while a
 *    process that hosted the turn at start is still running: an approval wait, a long local tool and
 *    a person away from the keyboard all write nothing while they last, and an automatic caller
 *    (CodeLens runs `recover --expire-open` every 15 minutes) cannot know which one it is looking at.
 *
 * A turn whose transcript is missing or unreadable has no proof either way and stays open: the
 * earlier attempts to treat "no transcript" as an interruption published turns that were still
 * running.
 */
export async function staleOpenTurnVerdict(args: {
  root: string
  open: RecorderOpenTurnState
  transcript?: TranscriptRead
  expireOpen: boolean
  now?: number
  quietMs?: number
}): Promise<StaleOpenTurnVerdict | undefined> {
  const { open, transcript } = args
  const now = args.now ?? Date.now()
  const threshold = args.quietMs ?? STALE_OPEN_TURN_QUIET_MS
  if (open.managedByScry) return undefined
  // A wake it asked for may still report: ending now would split one burst of work in two.
  if ((transcript?.pendingBackgroundTasks?.length ?? 0) > 0) return undefined
  const at = new Date(now).toISOString()
  const quiet = await openTurnQuiet(args.root, open, now)
  const silentFor = Number.isFinite(quiet.quietMs) ? `${Math.round(quiet.quietMs / 60_000)} minutes` : 'an unknown time'
  const replyFinished = !!transcript?.stopReason && FINISHED_STOP_REASONS.has(transcript.stopReason) &&
    transcript.complete !== false && transcript.identityMatched !== false
  if (open.sessionEndedAt) {
    // The host said the session ended. Whatever the transcript holds is the last of it.
    return {
      status: replyFinished || open.terminalFallbackStatus === 'completed' ? 'completed' : 'interrupted',
      at,
      endReason: 'session_end',
      reason: `the Provider session ended while this turn was still open (SessionEnd at ${open.sessionEndedAt}), so recovery published the lifecycle evidence it had`
    }
  }
  if (!Number.isFinite(quiet.quietMs) || quiet.quietMs < threshold) return undefined
  if (replyFinished) {
    return {
      status: 'completed',
      at,
      endReason: 'expired',
      reason: `no terminal event was observed; the Provider's last reply finished (stop_reason=${transcript!.stopReason}) and the session wrote nothing for ${silentFor}, so the turn was closed on its own transcript`
    }
  }
  if (args.expireOpen) {
    // A live host vetoes an automatic expiry: the turn may still be waiting on a person, a tool or a
    // plan approval, all of which write nothing to the transcript while they wait.
    const host = await hostProcessState(open.host)
    if (host === 'running') return undefined
    return {
      status: 'interrupted',
      at,
      endReason: 'expired',
      reason: host === 'gone'
        ? `no terminal event was observed and every process that hosted this turn at start is gone (recorded pids ${open.host!.map((process) => process.pid).join(', ')}); recovery force-closed the turn after ${silentFor} of silence`
        : `no terminal event was observed and an operator asserted the session is gone; recovery force-closed the turn after ${silentFor} of silence`
    }
  }
  return undefined
}
