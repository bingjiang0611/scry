import { captureReadBudget, turnMessageProjection } from './conversation-history-text'
import type { SideChatNativeTurn } from './conversation-service-deps'
import type { ProviderId } from '../shared/provider'

/**
 * The Provider's own raw transcript path, used only when a native session has no Scry
 * archive. That reader is separately bounded, so its turns are already in memory; what
 * matters here is which turns prove completion and which stay out of a frozen prefix.
 */
export interface ProjectedTurn {
  ordinal: number
  runId: string
  providerTurnId?: string
  status: string
  /**
   * Proven finished turn: the recorder terminal for a Scry archive, the Provider's
   * own terminal marker for a raw transcript. Visible text never settles a turn.
   */
  settled: boolean
  messages: Array<{ role: 'user' | 'assistant'; text: string; steerMessageId?: string }>
}

/** Native turns never gain an App archive, a parent binding or a recorder run here. */
export function projectedMessages(
  userData: string,
  cwd: string,
  turns: readonly SideChatNativeTurn[],
  evidenceOf: (turn: SideChatNativeTurn) => { status: string; settled: boolean }
): Promise<ProjectedTurn[]> {
  const budget = captureReadBudget()
  return turns.reduce(async (previous, turn, index) => {
    const projected = await previous
    const messages = await turnMessageProjection(userData, { cwd }, turn, budget)
    return [...projected, { ordinal: index + 1, runId: turn.runId, ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
      ...evidenceOf(turn), messages }]
  }, Promise.resolve<ProjectedTurn[]>([]))
}

/**
 * The stable prefix ends at the last settled turn; nothing after it is frozen.
 * An unsettled turn inside the prefix is not a tail Scry can drop, so the source
 * is refused instead of freezing output whose completion is unknown.
 */
export function completedProjections(turns: readonly ProjectedTurn[]): ProjectedTurn[] {
  const last = turns.findLastIndex(turn => turn.settled)
  if (last < 0) return []
  const prefix = turns.slice(0, last + 1)
  if (prefix.some(turn => !turn.settled)) {
    throw new Error('原生会话前缀包含没有终止证据的轮次，不能创建侧聊')
  }
  return prefix
}

/**
 * The only markers that prove a Provider finished a turn: Claude writes
 * `message.stop_reason`, Pi writes `message.stopReason`. `tool_use` / `toolUse`
 * means the turn is still producing, and a missing marker proves nothing.
 */
const completedStopReasons: Partial<Record<ProviderId, string>> = { claude: 'end_turn', pi: 'stop' }

export function stopReasonProvesCompletion(providerId: ProviderId, turn: { stopReason?: string }): boolean {
  const expected = completedStopReasons[providerId]
  return expected !== undefined && turn.stopReason === expected
}
