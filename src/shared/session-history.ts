import type { AgentInputAttachment } from './runtime'
import type { ActiveRun, TraceEvent } from './trace'

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

export interface SessionHistoryProjection {
  sessionKey: string
  legacyBefore?: true
  activeRun: ActiveRun | null
}

export interface SessionHistoryPage {
  workspaceMissing?: true
  turns: LoadedSessionTurn[]
  offset: number
  totalTurns: number
  hasOlder: boolean
  sourceComplete?: boolean
  completeness: 'complete' | 'partial'
  projection?: SessionHistoryProjection
}
