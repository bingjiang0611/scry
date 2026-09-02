import type { SessionProviderId } from '@shared/provider'
import type { ProjectMeta, SessionMeta } from './env'

export interface SessionSelectionIdentity {
  cwd: string | null
  sessionId?: string | null
  externalSessionId?: string
  runId?: string
  providerId?: SessionProviderId
  agentProfileId?: string
}

const identityAliases = (identity: SessionSelectionIdentity): string[] =>
  [identity.sessionId, identity.externalSessionId, identity.runId]
    .filter((id): id is string => Boolean(id))

export function sameSessionSelection(
  left: SessionSelectionIdentity,
  right: SessionSelectionIdentity
): boolean {
  if ((left.cwd ?? '') !== (right.cwd ?? '')) return false
  if (left.providerId !== right.providerId) return false
  if (left.agentProfileId !== right.agentProfileId) return false
  const leftAliases = new Set(identityAliases(left))
  return leftAliases.size > 0 && identityAliases(right).some((id) => leftAliases.has(id))
}

export function sessionSelectionChanged(
  current: SessionSelectionIdentity,
  next: SessionSelectionIdentity
): boolean {
  return !sameSessionSelection(current, next)
}

export function sessionMatchesSelection(
  cwd: string,
  session: SessionMeta,
  selection: SessionSelectionIdentity
): boolean {
  return sameSessionSelection(
    {
      cwd,
      sessionId: session.sessionId,
      externalSessionId: session.externalSessionId,
      runId: session.runId,
      providerId: session.providerId,
      agentProfileId: session.agentProfileId
    },
    selection
  )
}

export function selectedExternalSessionId(
  projects: ProjectMeta[],
  selection: SessionSelectionIdentity
): string | null {
  for (const project of projects) {
    const session = project.sessions.find((candidate) =>
      sessionMatchesSelection(project.cwd, candidate, selection)
    )
    if (session) return session.externalSessionId ?? null
  }
  return null
}
