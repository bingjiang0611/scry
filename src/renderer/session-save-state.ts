import type { ProjectMeta, SessionMeta } from './env'

/**
 * Quiet save status for one sidebar row while an optimistic change is written
 * behind it. Only catalog metadata (pin, archive, title) is changed this way:
 * main writes it to the app's own session index, it almost always succeeds and
 * is quietly reversible. Provider transcripts, git state and deletes are never
 * optimistic.
 */
export type SessionSaveAction = 'pin' | 'archive'
export type SessionSaveState =
  | { status: 'saving'; action: SessionSaveAction }
  | { status: 'saved'; action: SessionSaveAction }
  | { status: 'failed'; action: SessionSaveAction; reason: string }

export const sessionRowKey = (cwd: string, session: Pick<SessionMeta, 'providerId' | 'agentProfileId' | 'sessionId'>): string =>
  `${cwd}:${session.providerId}:${session.agentProfileId ?? ''}:${session.sessionId}`

/**
 * Applies a change to the one matching session in the project list; `null` removes it.
 * Rows are matched by cwd + provider + profile + session id, the sidebar's own key.
 * Returns the same array when nothing matched, so a stale rollback is a no-op.
 */
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
