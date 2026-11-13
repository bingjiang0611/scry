import type { AgentDataUpdated } from '../../shared/runtime'
import { followDaemonRun, installDaemonChannelResultHandler } from '../daemon-channel-gate'

// Daemon mode `conversation:send` (P3-conversation-send.md). The daemon records the send
// in its ledger and answers with that ledger run; the window follows it like a run it
// submitted, so its text streams here, then the conversation view refreshes. The
// renderer receives exactly the in-process answer.

interface DaemonSendAnswer {
  runId: string
  disposition: 'created' | 'duplicate'
  ledger?: { runId: string; seq?: number }
}

function parseAnswer(value: unknown): DaemonSendAnswer {
  const answer = value as Partial<DaemonSendAnswer> | null
  const ledger = answer?.ledger
  if (!answer || typeof answer.runId !== 'string' || (answer.disposition !== 'created' && answer.disposition !== 'duplicate') ||
    (ledger !== undefined && (typeof ledger?.runId !== 'string' || (ledger.seq !== undefined && !Number.isSafeInteger(ledger.seq))))) {
    throw new Error('invalid_daemon_response')
  }
  return answer as DaemonSendAnswer
}

export function installDaemonConversationSend(publish: (event: AgentDataUpdated) => void): () => void {
  return installDaemonChannelResultHandler('conversation:send', async (value, args) => {
    const answer = parseAnswer(value)
    if (answer.ledger) {
      try {
        const followed = await followDaemonRun(answer.ledger)
        // The daemon binds a conversation run under its turn's id; anything else is a
        // daemon fault worth seeing, not a reason to fail a send that already started.
        if (followed.bound && followed.runId !== answer.runId) console.warn('[scry] daemon bound a conversation run under another id:', answer.runId, followed.runId)
      } catch (error) {
        // The run started; the window can still read it from the conversation.
        console.warn('[scry] following the daemon conversation run failed:', error)
      }
    }
    const conversationId = (args[0] as { conversationId?: unknown } | undefined)?.conversationId
    if (typeof conversationId === 'string') publish({ kind: 'conversation_changed', conversationId })
    return { runId: answer.runId, disposition: answer.disposition }
  })
}
