import type { AgentTurnRecord, TurnEndReason } from '../../shared/turn-record.js'
import type { TranscriptRead } from './recorder-contracts.js'
import { hostProcessState } from './host-process.js'
import { openTurnQuiet, STALE_OPEN_TURN_QUIET_MS, type RecorderOpenTurnState } from './runtime-state.js'

const FINISHED_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'complete', 'completed', 'stop'])

export interface StaleOpenTurnVerdict {
  status: Extract<AgentTurnRecord['status'], 'completed' | 'interrupted'>
  at: string
  endReason: TurnEndReason
  reason: string
}

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
  if ((transcript?.pendingBackgroundTasks?.length ?? 0) > 0) return undefined
  const at = new Date(now).toISOString()
  const quiet = await openTurnQuiet(args.root, open, now)
  const silentFor = Number.isFinite(quiet.quietMs) ? `${Math.round(quiet.quietMs / 60_000)} minutes` : 'an unknown time'
  const replyFinished = !!transcript?.stopReason && FINISHED_STOP_REASONS.has(transcript.stopReason) &&
    transcript.complete !== false && transcript.identityMatched !== false
  if (open.sessionEndedAt) {
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
    if (await hostProcessState(open.host) !== 'gone') return undefined
    return {
      status: 'interrupted',
      at,
      endReason: 'expired',
      reason: `no terminal event was observed and every process that hosted this turn at start is gone (recorded pids ${open.host!.map((process) => process.pid).join(', ')}); recovery force-closed the turn after ${silentFor} of silence`
    }
  }
  return undefined
}
