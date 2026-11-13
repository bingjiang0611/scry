import type { ConversationPage } from '@shared/conversation-api'
import type { ActiveRun } from '@shared/trace'
import type { Turn } from './format'

/**
 * Timeline turns of one conversation page.
 *
 * A settled turn shows its archived history. The running turn shows its live stream. The
 * running turn whose live stream has not answered yet (still connecting, or paused because
 * the window is hidden) is still a running turn: it is shown as one, with the prompt the
 * user submitted, and never as a turn whose record is missing. Treating it as missing made
 * a side chat's first send read as "send result not confirmed" for the whole run.
 */
export function projectConversationTurns({ pageTurns, activeRunId, live, cwd, pending }: {
  pageTurns: ConversationPage['turns']
  activeRunId: string | undefined
  live: ActiveRun | undefined
  cwd: string
  /** The durable receipt of the submission in flight; its prompt is the submitted text. */
  pending?: { commandId: string; prompt: string }
}): Turn[] {
  return pageTurns.flatMap((turn): Turn[] => {
    const running = activeRunId === turn.runId
    const history = running && live?.runId === turn.runId ? live : turn.history
    if (history) {
      return [{ ...history, runId: turn.runId, ordinal: turn.ordinal, done: history.done === true,
        providerId: turn.providerId, cwd }]
    }
    if (!running) return []
    return [{ runId: turn.runId, ordinal: turn.ordinal, providerId: turn.providerId, cwd,
      userText: pending && pending.commandId === turn.commandId ? pending.prompt : '', items: [], done: false }]
  })
}

/** Turns whose record cannot be shown; the running turn is never one of them. */
export function missingConversationTurns(pageTurns: ConversationPage['turns'], activeRunId: string | undefined,
  live: ActiveRun | undefined): ConversationPage['turns'] {
  return pageTurns.filter(turn => !turn.history && live?.runId !== turn.runId && turn.runId !== activeRunId)
}
