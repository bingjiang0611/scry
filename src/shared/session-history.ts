import type { AgentInputAttachment } from './runtime'
import type { TraceEvent } from './trace'

// Wire-safe history projection shared by local IPC and authenticated remote reads.
export interface LoadedSessionTurn {
  runId?: string
  providerTurnId?: string
  forkTurnId?: string
  userText: string
  attachments?: AgentInputAttachment[]
  items: TraceEvent[]
  done?: boolean
  /**
   * Terminal marker the Provider wrote on this turn's last assistant message
   * (Pi `stopReason`). Absent when the source records prove no completion, so a
   * visible partial answer is never reported as a finished turn.
   */
  stopReason?: string
  error?: string
  errorHint?: string
}
