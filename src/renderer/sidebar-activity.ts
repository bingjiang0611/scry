import type { ConversationSummary } from '@shared/conversation-api'
import type { ProjectMeta, SessionMeta } from './env'
import { SIDEBAR_ACTIVITY_COPY as copy } from './constants/copy'

export type ActivityGroup = 'attention' | 'working' | 'completed'
export type ActivityEntry = {
  key: string
  project: ProjectMeta
  group: ActivityGroup
} & ({ kind: 'session'; session: SessionMeta } | { kind: 'conversation'; conversation: ConversationSummary })

export const activityGroups: { id: ActivityGroup; label: string }[] = [
  { id: 'attention', label: copy.attention },
  { id: 'working', label: copy.working },
  { id: 'completed', label: copy.completed }
]

export function sidebarActivity(
  projects: ProjectMeta[],
  runningRunIds: ReadonlySet<string>,
  waitingQuestionRunIds: ReadonlySet<string>,
  query: string
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
  // Preserve catalog order within each group; progress events do not add a second sort.
  return entries
}
