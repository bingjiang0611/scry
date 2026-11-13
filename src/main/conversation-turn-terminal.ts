import type { ProviderId } from '../shared/provider'

/**
 * What one Provider terminal marker proves about a turn.
 *
 * Termination and outcome are two facts, not one. A turn can end without succeeding, and
 * only a completed turn says the Provider finished the work. `terminal` is what allows a
 * turn to be a frozen side-chat boundary; `status` is the exact captured outcome that is
 * preserved into the snapshot. A marker outside the table below proves nothing, so a
 * visible body alone never makes a turn terminal.
 */
export type TurnTerminal =
  | { terminal: true; status: TurnTerminalStatus }
  | { terminal: false }

/** Outcomes a raw Provider transcript can prove by itself. */
export type TurnTerminalStatus = 'completed' | 'failed'

/**
 * Provider-documented `stop_reason` / `stopReason` values.
 *
 * Claude: `end_turn`/`stop_sequence` finished normally; `max_tokens`/`refusal`/
 * `model_context_window_exceeded` are explicit non-success terminals; `tool_use` and
 * `pause_turn` mean the turn is still producing.
 *
 * Pi: `stop` finished; `length`/`error` are explicit non-success terminals; `toolUse`
 * continues the turn. Pi's `aborted` is a model-side abort of the generation (see
 * `providers/pi-run-success.ts`: a clean RPC settle can still report `aborted`), so a raw
 * transcript cannot prove a user stop; it is reported as `failed`, never `interrupted`.
 */
const PROVIDER_TERMINALS: Partial<Record<ProviderId, Readonly<Record<string, TurnTerminalStatus>>>> = {
  claude: {
    end_turn: 'completed',
    stop_sequence: 'completed',
    max_tokens: 'failed',
    refusal: 'failed',
    model_context_window_exceeded: 'failed'
  },
  pi: {
    stop: 'completed',
    length: 'failed',
    error: 'failed',
    aborted: 'failed'
  }
}

export function providerTurnTerminal(providerId: ProviderId, stopReason: string | undefined): TurnTerminal {
  if (typeof stopReason !== 'string') return { terminal: false }
  const status = PROVIDER_TERMINALS[providerId]?.[stopReason.trim()]
  return status === undefined ? { terminal: false } : { terminal: true, status }
}

/** Prefix rule shared by every captured source: interior evidence gaps refuse the snapshot. */
export const NO_TERMINAL_TURN = '原生会话前缀包含没有终止证据的轮次，不能创建侧聊'
