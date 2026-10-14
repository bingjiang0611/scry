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
  error?: string
  errorHint?: string
}
