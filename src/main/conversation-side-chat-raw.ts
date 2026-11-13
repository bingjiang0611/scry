import { captureReadBudget, turnMessageProjection } from './conversation-history-text'
import type { SideChatNativeTurn } from './conversation-service-deps'
import { NO_TERMINAL_TURN, type TurnTerminal } from './conversation-turn-terminal'

/**
 * The Provider's own raw transcript path, used only when a native session has no Scry
 * archive. That reader is separately bounded, so its turns are already in memory; what
 * matters here is which turns are terminal, what their own marker proves about the
 * outcome, and which turns stay out of a frozen prefix.
 */
export interface ProjectedTurn {
  ordinal: number
  runId: string
  providerTurnId?: string
  /** Exact captured outcome; only a terminal turn carries one. */
  status?: string
  /**
   * Provider termination evidence for this turn. Visible text never makes a turn terminal,
   * and a terminal turn may still have failed: `status` says how it ended.
   */
  terminal: boolean
  messages: Array<{ role: 'user' | 'assistant'; text: string; steerMessageId?: string }>
}

/** Native turns never gain an App archive, a parent binding or a recorder run here. */
export function projectedMessages(
  userData: string,
  cwd: string,
  turns: readonly SideChatNativeTurn[],
  terminalOf: (turn: SideChatNativeTurn) => TurnTerminal
): Promise<ProjectedTurn[]> {
  const budget = captureReadBudget()
  return turns.reduce(async (previous, turn, index) => {
    const projected = await previous
    const messages = await turnMessageProjection(userData, { cwd }, turn, budget)
    const evidence = terminalOf(turn)
    return [...projected, {
      ordinal: index + 1, runId: turn.runId, ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
      terminal: evidence.terminal, ...(evidence.terminal ? { status: evidence.status } : {}), messages
    }]
  }, Promise.resolve<ProjectedTurn[]>([]))
}

/**
 * The stable prefix ends at the last terminal turn; nothing after it is frozen. A
 * nonterminal turn inside the prefix is not a tail Scry can drop, so the source is
 * refused instead of freezing output whose termination is unknown.
 */
export function terminalProjections(turns: readonly ProjectedTurn[]): ProjectedTurn[] {
  const last = turns.findLastIndex(turn => turn.terminal)
  if (last < 0) return []
  const prefix = turns.slice(0, last + 1)
  if (prefix.some(turn => !turn.terminal)) throw new Error(NO_TERMINAL_TURN)
  return prefix
}
