import type { ProviderId } from '../../shared/provider'

/**
 * Which session the window now shows after a history load: the App's own state, not
 * history evidence. In process the loader applies it where it always did; when the
 * daemon loads the page it returns the selection and the App applies it (B4-L4).
 */
export interface SessionSelection {
  providerId: ProviderId
  agentProfileId?: string
  cwd: string
  externalSessionId: string
  // Catalog says the session can be resumed: the window's session mirror follows it.
  canResume: boolean
  // A run for this session is still settling: keep the mirror's revision and aliases.
  loadingUnsettledRun: boolean
}

export interface SessionSelectionTarget {
  dockBadge: { view: (sessionKey: string | null, windowFocused: boolean) => void }
  isWindowFocused: () => boolean
  setCurrentCwd: (cwd: string | undefined) => void
  providerContextKey: (providerId: ProviderId, cwd: string, agentProfileId?: string) => string
  providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, agentProfileId?: string) => string
  bumpSessionRevision: (key: string) => void
  sessionAliasesByContext: Map<string, Map<string, string>>
  sessionByContext: Map<string, string>
}

export function applySessionSelection(target: SessionSelectionTarget, selection: SessionSelection): void {
  const { providerId, agentProfileId, cwd, externalSessionId } = selection
  target.dockBadge.view(target.providerSessionKey(providerId, cwd, externalSessionId, agentProfileId), target.isWindowFocused())
  target.setCurrentCwd(cwd || undefined)
  const key = target.providerContextKey(providerId, cwd, agentProfileId)
  if (!selection.loadingUnsettledRun) {
    target.bumpSessionRevision(key)
    target.sessionAliasesByContext.delete(key)
  }
  if (selection.canResume) target.sessionByContext.set(key, externalSessionId)
  else target.sessionByContext.delete(key)
}
