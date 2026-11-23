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
  /** The recorded workspace no longer exists: history is readable, the session is not resumable. */
  workspaceMissing?: true
  turns: LoadedSessionTurn[]
  /** Zero-based index of the first displayed turn in the full history. */
  offset: number
  totalTurns: number
  hasOlder: boolean
  /** False when a partial source cannot prove the full history. */
  sourceComplete?: boolean
  completeness: 'complete' | 'partial'
  projection?: SessionHistoryProjection
}
