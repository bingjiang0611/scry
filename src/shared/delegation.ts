import type { EvidenceQuality } from './turn-record-contracts'

export type DelegatedTaskStatus =
  | 'awaiting_confirmation'
  | 'declined'
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_interaction'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unavailable'

export interface DelegatedTaskSummaryView {
  status: 'available' | 'partial' | 'unavailable' | 'disabled'
  quality: EvidenceQuality
  value?: string
  omissionReason?: string
}

export interface DelegatedTaskView {
  taskId: string
  parentSessionKey: string
  parentRunId: string
  childSessionKey: string | null
  childRunId: string | null
  provider: string
  profile?: string | null
  permissionMode: string
  permissionModeSource: 'inherited' | 'requested'
  status: DelegatedTaskStatus
  stateVersion: number
  title: string | null
  confirmationQuestionId?: string | null
  cancelConfirmationQuestionId?: string | null
  summary?: DelegatedTaskSummaryView | null
  reason?: string | null
}

export interface DelegatedUsageBreakdownView {
  status: 'available' | 'partial'
  unavailableCount: number
  tokens: Partial<Record<'exact' | 'estimated' | 'inferred', number>>
  usd: Partial<Record<'exact' | 'estimated' | 'inferred', number>>
  credits: Partial<Record<'exact' | 'estimated' | 'inferred', number>>
}

export interface SessionLineageRef {
  sessionKey: string
  title?: string | null
  parentSessionKey?: string | null
  lineageKind?: 'fork' | 'side_chat' | 'delegated' | null
}

export interface GroupedSessionWithDelegated<T extends SessionLineageRef> {
  session: T
  delegatedChildren: T[]
}

/**
 * Nests `delegated` child sessions under their parent session for the sidebar (P6 tools §8).
 * Orphaned delegated sessions (whose parent is absent from the current page) stay visible at top level.
 */
export function groupSessionsWithDelegatedChildren<T extends SessionLineageRef>(
  sessions: readonly T[]
): GroupedSessionWithDelegated<T>[] {
  const byKey = new Map<string, T>()
  for (const s of sessions) byKey.set(s.sessionKey, s)

  const childrenByParent = new Map<string, T[]>()
  const topLevel: T[] = []
  for (const s of sessions) {
    if (s.lineageKind === 'delegated' && s.parentSessionKey && byKey.has(s.parentSessionKey)) {
      const list = childrenByParent.get(s.parentSessionKey) ?? []
      list.push(s)
      childrenByParent.set(s.parentSessionKey, list)
    } else {
      topLevel.push(s)
    }
  }
  return topLevel.map((session) => ({
    session,
    delegatedChildren: childrenByParent.get(session.sessionKey) ?? []
  }))
}

export interface DelegationStateQuery {
  cwd?: string | null
  parentSessionKey?: string | null
}

export interface DelegationStateSnapshot {
  projectDelegationEnabled: boolean
  sessionFullAccessEnabled: boolean
  tasks: DelegatedTaskView[]
  usageBreakdown: DelegatedUsageBreakdownView
}

export interface DelegationProjectPolicyRequest {
  cwd: string
  enabled: boolean
  targetLabel?: string
}

export interface DelegationSessionFullAccessRequest {
  sessionKey: string
  enabled: boolean
  targetLabel?: string
  providerFullAccessCopy?: string
}

export interface DelegationConfirmTaskRequest {
  taskId: string
  questionId: string
  approved: boolean
  reason?: string
}

export interface DelegationConfirmCancelRequest {
  taskId: string
  questionId: string
  approved: boolean
  reason?: string
}

export interface DelegationStopSubtasksRequest {
  parentSessionKey: string
  reason?: string
}

export interface DelegationActionResult {
  ok: boolean
  status?: string
  reason?: string
  cancelled?: boolean
  stoppedCount?: number
}
