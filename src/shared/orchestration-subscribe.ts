import type { HostAdminNotice } from './host-admin'
import type { AgentDataUpdated, RuntimeProvider } from './runtime'
import type { SessionAttentionSnapshot } from './session-attention'
import type { SessionHistoryPage } from './session-history'
import type { ConversationPage } from './conversation-api'
import type { DesktopHostReadResult } from './desktop-remote'

/**
 * Shared wire contract for P4-3 local `subscribe` (P4-orchestration-protocol.md §5).
 * Kept in `src/shared/` with zero imports from `src/host-runtime/orchestration/`
 * so Electron main preserves the Layer 3 single-writer static import boundary.
 */

export type SubscribeView = 'sessions' | 'activeRuns' | 'detail'

export const SUBSCRIBE_VIEWS: ReadonlySet<SubscribeView> = new Set(['sessions', 'activeRuns', 'detail'])

/**
 * Window notices retained as volatile hints in P4-3 (`protocol §5.3`).
 * `agent:turnDone`, `agent:session`, and `agent:stopState` are superseded by durable run events.
 */
export const SUBSCRIBE_RETAINED_WINDOW_NOTICES: ReadonlySet<string> = new Set([
  'agent:error',
  'agent:backgroundWork',
  'agent:deleteArchivedProgress',
  'agent:questionAttention'
])

export interface SubscribeKnownCursor {
  hostId: string
  logId: string
  seq: number
}

export interface SubscribeSessionRef {
  sessionKey: string
  providerId?: string
  agentProfileId?: string
  cwd?: string
  externalSessionId?: string
}

export interface SubscribeRequest {
  views: SubscribeView[]
  session?: SubscribeSessionRef
  known?: SubscribeKnownCursor
  sessionsCursor?: string
  /** Local App detail already displays its history page. Watch the focused source. */
  detailWatch?: 'open' | 'continue'
  waitMs: number
  eventSet?: number
  chunk?: { id: string; offset: number }
}

export interface SessionCatalogMetadata {
  nativeSessionId: string | null
  projectCwd: string | null
  preview: string | null
  runtimeProvider: RuntimeProvider | null
}

export interface SubscribeSessionRow {
  sessionKey: string
  conversationId: string | null
  provider: string | null
  profile: string | null
  cwd: string | null
  title: string | null
  ts: number
  pinnedAt: number | null
  archivedAt: number | null
  lastRunId: string | null
  lastRunOutcome: unknown | null
  activeRunId: string | null
  pendingQuestions: number
  legacy: boolean
  revSeq: number
  catalog?: SessionCatalogMetadata
}

export interface SubscribeActiveRunRow {
  runId: string
  /** Canonical scryRunId bound by remote-run-binding while live (local scope only). */
  scryRunId?: string
  /** Whether canonical pipeline registered the run (local scope only). */
  admitted?: boolean
  /** Native external session id bound while live (local scope only). */
  externalSessionId?: string
  sessionKey: string | null
  scope: 'local' | 'remote' | 'system'
  origin: string
  provider: string | null
  profile: string | null
  cwd: string | null
  promptPreview: string | null
  lifecycle: string
  stopState: string | null
  outputSeq: number | null
  intentSeq: number
  settledAt: number | null
  recoveredAt: number | null
  outcome: unknown | null
  revSeq: number
}

export interface SubscribeEventItem {
  seq: number
  type: string
  stream: string
  at: number
  sessionKey?: string | null
  runId?: string | null
  cwd?: string | null
  payload: Record<string, unknown>
  evidence?: string[] | null
}

export type SubscribeHint =
  | {
      kind: 'run'
      runId: string
      outputSeq: number
      scryRunId?: string
      admitted?: boolean
      cwd?: string
      providerId?: string
      agentProfileId?: string
      externalSessionId?: string
    }
  | { kind: 'terminal' }
  | { kind: 'oauth'; url: string }
  | { kind: 'hostNotice'; notice: HostAdminNotice }
  | { kind: 'attention'; snapshot: SessionAttentionSnapshot }
  | { kind: 'window'; channel: string; payload: Record<string, unknown> }
  | { kind: 'data'; event: AgentDataUpdated }

export type SubscribeHistoryPage = SessionHistoryPage | { kind: 'conversation'; page: ConversationPage }

export interface SubscribeSnapshot {
  sessions?: {
    rows: SubscribeSessionRow[]
    total: number | 'unavailable'
    nextCursor?: string
  }
  activeRuns?: {
    rows: SubscribeActiveRunRow[]
  }
  detail?: {
    turns: unknown[]
    legacyBefore?: true
    firstPage?: SubscribeHistoryPage
  }
}

export type SubscribeReply =
  | {
      hostId: string
      logId: string
      seq: number
      mode: 'snapshot'
      snapshot: SubscribeSnapshot
      hints?: SubscribeHint[]
    }

  | {
      hostId: string
      logId: string
      seq: number
      mode: 'events'
      events: SubscribeEventItem[]
      hints?: SubscribeHint[]
    }
  | {
      hostId: string
      logId: string
      seq: number
      mode: 'idle'
      hints?: SubscribeHint[]
    }

export type SubscribeResponse = SubscribeReply | Extract<DesktopHostReadResult, { kind: 'history_chunk' }>
