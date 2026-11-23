import type { RemoteHistoryTurnsPage } from './remote-history-turns'
import type { HostAdminNotice } from './host-admin'
import type { AgentDataUpdated, AgentQuestionRequest, RuntimeProvider } from './runtime'
import type { SessionAttentionSnapshot } from './session-attention'
import type { SessionHistoryPage } from './session-history'
import type { ConversationPage } from './conversation-api'
import type { DesktopHostReadResult, DesktopRemoteHistory } from './desktop-remote'
import type { WorkspacePrepareProgress } from './workspace-selection'


export type SubscribeView = 'sessions' | 'activeRuns' | 'detail'

export const SUBSCRIBE_MAX_TRACKED_RUN_IDS = 128

export const SUBSCRIBE_VIEWS: ReadonlySet<SubscribeView> = new Set(['sessions', 'activeRuns', 'detail'])

export const SUBSCRIBE_RETAINED_WINDOW_NOTICES: ReadonlySet<string> = new Set([
  'agent:error',
  'agent:backgroundWork',
  'agent:deleteArchivedProgress',
  'workspaceSelection:progress'
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
  subscriptionId?: string
  historyFormat?: 'turns'
  historyOnly?: true
  detailWatch?: 'open' | 'continue'
  trackedRunIds?: string[]
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
  scryRunId?: string
  traceRunId?: string
  questions?: AgentQuestionRequest[]
  isConversationRun?: boolean
  admitted?: boolean
  externalSessionId?: string
  workspaceProgress?: WorkspacePrepareProgress
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
  sessionRow?: SubscribeSessionRow | null
  runRow?: SubscribeActiveRunRow | null
}

export type SubscribeHint =
  | {
      kind: 'run'
      runId: string
      outputSeq: number
      scryRunId?: string
      traceRunId?: string
      admitted?: boolean
      cwd?: string
      providerId?: string
      agentProfileId?: string
      externalSessionId?: string
      workspaceProgress?: WorkspacePrepareProgress
    }
  | { kind: 'terminal' }
  | { kind: 'oauth'; url: string }
  | { kind: 'hostNotice'; notice: HostAdminNotice }
  | { kind: 'attention'; snapshot: SessionAttentionSnapshot }
  | { kind: 'window'; channel: string; payload: Record<string, unknown> }
  | { kind: 'data'; event: AgentDataUpdated }

export type SubscribeHistoryPage =
  | SessionHistoryPage
  | { kind: 'conversation'; page: ConversationPage }
  | { kind: 'remoteHistory'; history: DesktopRemoteHistory }
  | { kind: 'mobileHistory'; page: RemoteHistoryTurnsPage }

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
