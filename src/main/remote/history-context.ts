import type { AppSession } from '../app-store'
import type { RemoteHistoryQuery } from './remote-gateway'

// A display scope is authority over one catalog session, not evidence that all
// its turns used the current execution Profile. Keep those identities separate.
export function bindRemoteHistoryContext(
  input: RemoteHistoryQuery,
  sessions: readonly Pick<AppSession, 'providerId' | 'cwd' | 'sessionId' | 'externalSessionId' | 'agentProfileId'>[],
  authorizeWorkspace: (cwd: string) => string
): { canonical: string; scope: 'session' | 'profile'; profile: string | null | undefined } {
  const canonical = authorizeWorkspace(input.cwd)
  const scope = input.historyScope ?? (input.agentProfileId !== undefined ? 'profile' : 'session')
  const directories = new Map<string, string | null>([[input.cwd, canonical], [canonical, canonical]])
  const candidates = sessions.filter(session => {
    if ((session.providerId ?? 'legacy_unknown') !== input.providerId ||
        (session.externalSessionId ?? session.sessionId) !== input.externalSessionId) return false
    if (!directories.has(session.cwd)) {
      try { directories.set(session.cwd, authorizeWorkspace(session.cwd)) }
      catch { directories.set(session.cwd, null) } // Same unavailable-project policy as the public catalog.
    }
    return directories.get(session.cwd) === canonical
  })
  if (!candidates.length) throw new Error('history_session_not_found')
  const catalog = candidates.find(session => session.agentProfileId === input.agentProfileId) ??
    candidates.find(session => session.agentProfileId === undefined)
  if (!catalog) throw new Error('history_session_profile_mismatch')
  if (scope === 'profile' && (catalog.agentProfileId === undefined || catalog.agentProfileId !== input.agentProfileId)) {
    throw new Error('history_profile_unavailable')
  }
  // An explicit client selector still scopes the live overlay when the old
  // catalog lacks a Profile. It never backfills provenance on durable turns.
  return { canonical, scope, profile: input.agentProfileId !== undefined ? input.agentProfileId : catalog.agentProfileId }
}
