import type { ProviderId } from '../../shared/provider'
import type { ActiveRun } from '../../shared/trace'
import { conversationAttentionKey, sessionAttentionKey, type SessionAttentionSnapshot } from '../../shared/session-attention'
import { DockBadgeState } from '../dock-badge'

// The attention pieces both processes build: the App for its window's dock badge, the
// daemon for the unread set it reports to that window. Free of Provider, store and
// Electron imports, so the App main entry can use them without the run pipeline.

export const providerSessionKey = (providerId: ProviderId, cwd: string, sessionId: string, agentProfileId?: string): string =>
  sessionAttentionKey({ providerId, agentProfileId, cwd, sessionId })

export const providerContextKey = (providerId: ProviderId, cwd: string, agentProfileId?: string): string =>
  `${providerId}\0${agentProfileId ?? ''}\0${cwd}`

export function activeRunSessionKey(run: ActiveRun): string | null {
  if (run.attentionKey) return run.attentionKey
  if (run.conversationId) return conversationAttentionKey(run.conversationId)
  if (!run.providerId) return null
  return providerSessionKey(
    run.providerId,
    run.cwd ?? '',
    run.externalSessionId ?? run.sessionId ?? run.runId,
    run.agentProfileId
  )
}

export function createDockBadge({
  setBadgeCount,
  publishUnreadSessions
}: {
  setBadgeCount: (count: number) => boolean
  publishUnreadSessions: (snapshot: SessionAttentionSnapshot) => void
}): DockBadgeState {
  let badgePermissionWarningShown = false
  return new DockBadgeState((count) => {
    if (setBadgeCount(count) || process.platform !== 'darwin' || badgePermissionWarningShown) return
    badgePermissionWarningShown = true
    console.warn('[scry] macOS Dock badge permission is unavailable')
  }, (snapshot) => {
    try {
      publishUnreadSessions(snapshot)
    } catch (error) {
      console.warn('[scry] unread session notification failed:', error)
    }
  })
}
