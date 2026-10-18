import type { ConversationSummary } from '@shared/conversation-api'
import type { ProjectMeta, SessionMeta } from './env'

export type ActivityGroup = 'attention' | 'working' | 'recent'
export type ActivityEntry = {
  key: string
  project: ProjectMeta
  group: ActivityGroup
} & ({ kind: 'session'; session: SessionMeta } | { kind: 'conversation'; conversation: ConversationSummary })

export const activityGroups: { id: ActivityGroup; label: string }[] = [
  { id: 'attention', label: '等待回复' },
  { id: 'working', label: '运行中' },
  // Catalog history has no authoritative terminal outcome. Inactive is not success.
  { id: 'recent', label: '最近' }
]

export function sidebarActivity(
  projects: ProjectMeta[],
  runningRunIds: ReadonlySet<string>,
  waitingQuestionRunIds: ReadonlySet<string>,
  query: string
): ActivityEntry[] {
  const entries: ActivityEntry[] = []
  const needle = query.trim().toLocaleLowerCase()
  const group = (runId?: string): ActivityGroup => runId && waitingQuestionRunIds.has(runId)
    ? 'attention'
    : runId && runningRunIds.has(runId) ? 'working' : 'recent'
  for (const project of projects) {
    const matches = (title: string): boolean => !needle || `${project.name} ${project.cwd} ${title}`.toLocaleLowerCase().includes(needle)
    for (const conversation of project.conversations ?? []) {
      if (conversation.archivedAt || !matches(conversation.title)) continue
      entries.push({ key: `conversation:${conversation.id}`, kind: 'conversation', project, conversation,
        group: conversation.activeRunId ? waitingQuestionRunIds.has(conversation.activeRunId) ? 'attention' : 'working' : 'recent' })
    }
    for (const session of project.sessions) {
      if (session.archivedAt || !matches(session.preview)) continue
      entries.push({ key: `session:${JSON.stringify([project.cwd, session.providerId, session.agentProfileId, session.sessionId])}`,
        kind: 'session', project, session, group: group(session.runId) })
    }
  }
  // Preserve catalog order within each group; progress events do not add a second sort.
  return entries
}
