import type { ConversationSummary } from '@shared/conversation-api'
import { sessionAttentionKey } from '@shared/session-attention'
import type { ProjectMeta, SessionMeta } from './env'
import type { RemoteSessionRef } from '@shared/desktop-remote'
import type { RemoteProjectGroup } from './components/SidebarRemoteProjects'
import { SIDEBAR_ACTIVITY_COPY as copy } from './constants/copy'
import { conversationSourceKey, nativeSourceKey, parentKeyOf } from './side-chat-index'

export type ActivityGroup = 'attention' | 'working' | 'updates' | 'completed'
export type ActivityEntry = {
  key: string
  group: ActivityGroup
} & (
  | { kind: 'session'; project: ProjectMeta; session: SessionMeta }
  | { kind: 'conversation'; project: ProjectMeta; conversation: ConversationSummary }
  | { kind: 'remote'; project: RemoteProjectGroup; session: RemoteSessionRef }
)

export const activityGroups: { id: ActivityGroup; label: string }[] = [
  { id: 'attention', label: copy.attention },
  { id: 'working', label: copy.working },
  { id: 'updates', label: copy.updates },
  { id: 'completed', label: copy.completed }
]

/**
 * One mapping for every activity row, so local conversations, local sessions and remote
 * sessions cannot disagree about what a run means.
 *
 * Blocked and waiting evidence outranks liveness: a run that is waiting for the user is
 * not "in progress". A terminal non-success is reviewable evidence, not an absence —
 * dropping it would make a failed, cancelled or interrupted run look like nothing
 * happened. Only an explicit `completed` outcome is shown as completed.
 */
export function activityGroupOf(evidence: {
  active: boolean
  /** Waiting on the user: a pending question, or a host-reported blocked run. */
  blocked: boolean
  outcome?: SessionMeta['lastRunOutcome']
  unread?: boolean
}): ActivityGroup | undefined {
  if (evidence.blocked) return 'attention'
  if (evidence.active) return 'working'
  if (evidence.outcome === 'completed') return 'completed'
  if (evidence.outcome === 'failed' || evidence.outcome === 'cancelled' || evidence.outcome === 'interrupted') {
    return 'updates'
  }
  return evidence.unread ? 'updates' : undefined
}

export function sidebarActivity(
  projects: ProjectMeta[],
  runningRunIds: ReadonlySet<string>,
  waitingQuestionRunIds: ReadonlySet<string>,
  query: string,
  remoteProjects: readonly RemoteProjectGroup[] = [],
  unreadSessionKeys: ReadonlySet<string> = new Set()
): ActivityEntry[] {
  const entries: ActivityEntry[] = []
  const needle = query.trim().toLocaleLowerCase()
  const group = (evidence: {
    active: boolean
    runId?: string
    /** Conversation-only: a durable block the user must resolve, never a liveness reading. */
    blocked?: boolean
    outcome?: SessionMeta['lastRunOutcome']
    unread?: boolean
  }): ActivityGroup | undefined => activityGroupOf({
    active: evidence.active,
    blocked: evidence.blocked === true || Boolean(evidence.runId && waitingQuestionRunIds.has(evidence.runId)),
    outcome: evidence.outcome,
    unread: evidence.unread
  })
  // A side chat is never a row here: it lives in its parent's right panel. Its live run is
  // still activity the user may have to act on, so a child that is waiting or running
  // lifts the row of the session it belongs to instead of adding a second one. A finished
  // child adds nothing; its result is read in the parent's panel.
  const childActivity = new Map<string, 'attention' | 'working'>()
  for (const project of projects) {
    for (const conversation of project.conversations ?? []) {
      const runId = conversation.activeRunId
      if (!conversation.sideChat || conversation.archivedAt || !runId) continue
      const key = parentKeyOf(conversation.sideChat.source)
      if (waitingQuestionRunIds.has(runId)) childActivity.set(key, 'attention')
      else if (!childActivity.has(key)) childActivity.set(key, 'working')
    }
  }
  /** Waiting outranks running, and a parent's own waiting state is never lowered. */
  const lifted = (own: ActivityGroup | undefined, parentKey: string): ActivityGroup | undefined => {
    const child = childActivity.get(parentKey)
    if (!child || own === 'attention') return own
    return child
  }
  for (const project of projects) {
    const matches = (title: string): boolean => !needle || `${project.name} ${project.cwd} ${title}`.toLocaleLowerCase().includes(needle)
    for (const conversation of project.conversations ?? []) {
      if (conversation.sideChat || conversation.archivedAt || !matches(conversation.title)) continue
      // A conversation's active run id is its own liveness evidence. Only a durable block
      // outranks it: deletion, an unaccepted native fork, or a delivery whose outcome is
      // unresolved with no live run to watch. `blockedReason` alone cannot decide this —
      // it also carries the ordinary "request still in flight" note, which is progress.
      const active = Boolean(conversation.activeRunId)
      const status = lifted(group({
        active,
        runId: conversation.activeRunId,
        blocked: Boolean(conversation.deletion) ||
          (conversation.fork !== undefined && conversation.fork.status !== 'accepted') ||
          (!active && conversation.blockedReason !== undefined),
        outcome: conversation.lastRunOutcome
      }), conversationSourceKey(conversation.id))
      if (!status) continue
      entries.push({ key: `conversation:${conversation.id}`, kind: 'conversation', project, conversation, group: status })
    }
    for (const session of project.sessions) {
      if (session.archivedAt || !matches(session.preview)) continue
      const cwd = session.cwd ?? project.cwd
      // The same unread evidence powers the project-list blue dot. It proves a new
      // result needs review, not success: older catalogs can lack an outcome.
      const unread = unreadSessionKeys.has(sessionAttentionKey({ providerId: session.providerId,
        agentProfileId: session.agentProfileId, cwd, sessionId: session.externalSessionId ?? session.sessionId }))
      const status = lifted(group({ active: Boolean(session.runId && runningRunIds.has(session.runId)),
        runId: session.runId, outcome: session.lastRunOutcome, unread }),
      nativeSourceKey({ providerId: session.providerId, agentProfileId: session.agentProfileId, cwd,
        nativeSessionId: session.externalSessionId ?? session.sessionId }))
      if (status) entries.push({ key: `session:${JSON.stringify([cwd, session.providerId, session.agentProfileId, session.sessionId])}`,
        kind: 'session', project, session, group: status })
    }
  }
  for (const project of remoteProjects) {
    // Cached activity after a disconnect/read failure is not current evidence.
    // Completion is host-persisted; never infer success from an inactive session.
    if (project.state !== 'connected') continue
    for (const session of project.sessions) {
      if (session.archivedAt || !session.externalSessionId) continue
      // The host reports both liveness and the questions its runs are blocked on, so a
      // remote run awaiting the user is attention rather than background progress.
      const status = activityGroupOf({
        active: session.isActive === true,
        blocked: (session.pendingQuestions ?? 0) > 0,
        outcome: session.lastRunOutcome
      })
      if (!status) continue
      if (needle && !`${project.connection.label} ${project.name} ${project.cwd} ${session.label}`.toLocaleLowerCase().includes(needle)) continue
      entries.push({
        key: `remote:${JSON.stringify([project.connection.id, project.cwd, session.providerId, session.agentProfileId, session.externalSessionId])}`,
        kind: 'remote', project, session, group: status
      })
    }
  }
  // Preserve catalog order within each group; progress events do not add a second sort.
  return entries
}
