import type { ProjectMeta, SessionMeta } from './env'

export type SessionSaveAction = 'pin' | 'archive'
export type SessionSaveState =
  | { status: 'saving'; action: SessionSaveAction }
  | { status: 'saved'; action: SessionSaveAction }
  | { status: 'failed'; action: SessionSaveAction; reason: string }

export const sessionRowKey = (cwd: string, session: Pick<SessionMeta, 'providerId' | 'agentProfileId' | 'sessionId'>): string =>
  `${cwd}:${session.providerId}:${session.agentProfileId ?? ''}:${session.sessionId}`

export function patchProjectSession(
  projects: ProjectMeta[],
  cwd: string,
  target: Pick<SessionMeta, 'providerId' | 'agentProfileId' | 'sessionId'>,
  patch: Partial<Pick<SessionMeta, 'pinnedAt' | 'preview'>> | null
): ProjectMeta[] {
  const key = sessionRowKey(cwd, target)
  let changed = false
  const next = projects.map((project) => {
    const index = project.sessions.findIndex((session) => sessionRowKey(session.cwd ?? project.cwd, session) === key)
    if (index < 0) return project
    changed = true
    const sessions = [...project.sessions]
    if (patch === null) sessions.splice(index, 1)
    else sessions[index] = { ...sessions[index], ...patch }
    return { ...project, sessions }
  })
  return changed ? next : projects
}
