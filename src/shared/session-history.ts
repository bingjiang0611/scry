import type { AgentInputAttachment } from './runtime'
import type { TraceEvent } from './trace'

export interface LoadedSessionTurn {
  runId?: string
  providerTurnId?: string
  forkTurnId?: string
  userText: string
  attachments?: AgentInputAttachment[]
  items: TraceEvent[]
  done?: boolean
  stopReason?: string
  error?: string
  errorHint?: string
}
