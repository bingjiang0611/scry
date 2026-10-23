import type { ConversationSummary } from '@shared/conversation-api'
import type { ProjectMeta, SessionMeta } from './env'
import type { RemoteSessionRef } from '@shared/desktop-remote'
import type { RemoteProjectGroup } from './components/SidebarRemoteProjects'
import { SIDEBAR_ACTIVITY_COPY as copy } from './constants/copy'

export type ActivityGroup = 'attention' | 'working' | 'completed'
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
  { id: 'completed', label: copy.completed }
]

export function sidebarActivity(
  projects: ProjectMeta[],
  runningRunIds: ReadonlySet<string>,
  waitingQuestionRunIds: ReadonlySet<string>,
  query: string,
  remoteProjects: readonly RemoteProjectGroup[] = []
): ActivityEntry[] {
  const entries: ActivityEntry[] = []
  const needle = query.trim().toLocaleLowerCase()
  const group = (runId?: string, outcome?: SessionMeta['lastRunOutcome']): ActivityGroup | undefined => runId && waitingQuestionRunIds.has(runId)
    ? 'attention'
    : runId && runningRunIds.has(runId) ? 'working' : outcome === 'completed' ? 'completed' : undefined
  for (const project of projects) {
    const matches = (title: string): boolean => !needle || `${project.name} ${project.cwd} ${title}`.toLocaleLowerCase().includes(needle)
    for (const conversation of project.conversations ?? []) {
      if (conversation.archivedAt || !matches(conversation.title)) continue
      const status = conversation.activeRunId
        ? waitingQuestionRunIds.has(conversation.activeRunId) ? 'attention' : 'working'
        : group(undefined, conversation.lastRunOutcome)
      if (status) entries.push({ key: `conversation:${conversation.id}`, kind: 'conversation', project, conversation, group: status })
    }
    for (const session of project.sessions) {
      if (session.archivedAt || !matches(session.preview)) continue
      const status = group(session.runId, session.lastRunOutcome)
      if (status) entries.push({ key: `session:${JSON.stringify([project.cwd, session.providerId, session.agentProfileId, session.sessionId])}`,
        kind: 'session', project, session, group: status })
    }
  }
  for (const project of remoteProjects) {
    // Cached activity after a disconnect/read failure is not current evidence.
    // Completion is host-persisted; never infer success from an inactive session.
    if (project.state !== 'connected') continue
    for (const session of project.sessions) {
      if (session.archivedAt || !session.externalSessionId) continue
      const status = session.isActive ? 'working' : session.lastRunOutcome === 'completed' ? 'completed' : undefined
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
