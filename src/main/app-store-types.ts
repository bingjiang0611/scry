import type { SessionProviderId } from '../shared/provider'
import type { RuntimeProvider } from '../shared/runtime'
import type { AgentTurnRecord } from '../shared/turn-record'

export interface AppSession {
  sessionId: string
  runId?: string
  lastRunOutcome?: AgentTurnRecord['status']
  externalSessionId?: string
  providerId?: SessionProviderId
  agentProfileId?: string
  runtimeProvider?: RuntimeProvider
  cwd: string
  /** Sidebar grouping root. Execution and Provider evidence still use cwd. */
  projectCwd?: string
  preview: string
  /** User-authored local label; record() may update preview, never this field. */
  title?: string
  ts: number
  pinnedAt?: number
  archivedAt?: number
}

export interface SessionMeta {
  sessionId: string
  runId?: string
  lastRunOutcome?: AgentTurnRecord['status']
  externalSessionId?: string
  pending?: boolean
  providerId: SessionProviderId
  agentProfileId?: string
  runtimeProvider?: RuntimeProvider
  mtime: number
  preview: string
  count: number
  /** Present when this session executes in a worktree grouped under another project root. */
  cwd?: string
  pinnedAt?: number
  archivedAt?: number
}

export interface ProjectMeta {
  cwd: string
  name: string
  mtime: number
  sessions: SessionMeta[]
  pinnedAt?: number
}

export interface ProjectRecord {
  cwd: string
  name?: string
  lastOpenedAt: number
  pinnedAt?: number
  removedAt?: number
}

/** 定位单条 catalog 会话：Provider + profile + 工作目录 + Provider 侧会话 id。 */
export interface AppSessionRef {
  providerId: SessionProviderId
  agentProfileId?: string
  cwd: string
  externalSessionId: string
}

export function appSessionCanResume(session: Pick<AppSession, 'runId' | 'externalSessionId'>): boolean {
  return !(session.runId && session.externalSessionId === session.runId)
}
