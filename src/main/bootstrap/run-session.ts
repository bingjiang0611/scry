import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ActiveRun } from '../../shared/trace'
import type { RuntimeProvider } from '../../shared/runtime'
import type { ProviderId } from '../../shared/provider'
import type { createAppSessionStore } from '../app-store'
import type { SessionDiffBaselineRegistry } from '../session-diff'
import type { DockBadgeState } from '../dock-badge'
import { updateRunAttachmentOwner } from '../attachment-store'

type SessionRuns = { isViewed: (runId: string) => boolean }
export function createSessionPublisher(deps: {
  runState: ActiveRun
  providerId: ProviderId
  agentProfileId?: string
  runtimeProvider: RuntimeProvider
  runId: string
  cwd: string | undefined
  catalogCwd: string
  displayPrompt: string
  contextKey: string
  editSourceSessionId?: string
  managedConversation?: unknown
  isRemoteRun: boolean
  onSession?: (sessionId: string) => void
  getContextRevision: () => number
  getDiffContextKey: () => string
  setDiffContextKey: (key: string) => void
  setObservedSessionId: (sessionId: string) => void
  sessionBaselineKey: (context: string, sessionId: string) => string
  sessionDiffBaselines: SessionDiffBaselineRegistry
  sessionByContext: Map<string, string>
  sessionAliasesByContext: Map<string, Map<string, string>>
  scopedSessionKey: (sessionId: string) => string
  dockBadge: DockBadgeState
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  runs: SessionRuns
  getWindow: () => BrowserWindow | null
  initialSessionId?: string
  sessionRevisionByContext: Map<string, number>
}) {
  let notifiedSessionId = deps.initialSessionId
  const publishSessionId = (sessionId: string | undefined): void => {
    if (!sessionId) return
    deps.setObservedSessionId(sessionId)
    if (deps.isRemoteRun) deps.onSession?.(sessionId)
    deps.setDiffContextKey(deps.sessionDiffBaselines.promote(deps.getDiffContextKey(), deps.sessionBaselineKey(deps.contextKey, sessionId), sessionId))
    if (!deps.managedConversation && !deps.isRemoteRun && (deps.sessionRevisionByContext.get(deps.contextKey) ?? 0) === deps.getContextRevision()) {
      deps.sessionByContext.set(deps.contextKey, sessionId)
      deps.sessionAliasesByContext.set(deps.contextKey, new Map([[deps.runId, sessionId]]))
    }
    const previousSessionKey = deps.scopedSessionKey(deps.runState.externalSessionId ?? deps.runState.sessionId ?? deps.runId)
    deps.runState.sessionId = sessionId
    deps.runState.externalSessionId = sessionId
    deps.dockBadge.rekey(previousSessionKey, deps.scopedSessionKey(sessionId))
    if (deps.cwd) {
      try { updateRunAttachmentOwner(app.getPath('userData'), deps.runId, { providerId: deps.providerId, cwd: deps.cwd, sessionId }) } catch (error) {
        console.warn('[scry] attachment ownership update deferred:', deps.runId, error)
      }
    }
    try {
      deps.appSessionStore().record({
        providerId: deps.providerId,
        agentProfileId: deps.agentProfileId,
        runtimeProvider: deps.runtimeProvider,
        runId: deps.runId,
        externalSessionId: sessionId,
        cwd: deps.catalogCwd,
        prompt: deps.displayPrompt
      })
    } catch (error) {
      console.warn('[scry] native session catalog update deferred:', deps.runId, error)
    }
    if (deps.runs.isViewed(deps.runId)) {
      deps.dockBadge.view(deps.scopedSessionKey(sessionId), Boolean(deps.getWindow()?.isFocused()))
    }
    if (notifiedSessionId === sessionId) return
    notifiedSessionId = sessionId
    try {
      deps.getWindow()?.webContents.send('agent:session', {
        runId: deps.runId,
        sessionId,
        previousSessionId: deps.editSourceSessionId ?? deps.runId,
        externalSessionId: sessionId,
        providerId: deps.providerId,
        agentProfileId: deps.agentProfileId
      })
    } catch (error) {
      console.warn('[scry] native session renderer notification failed:', deps.runId, error)
    }
  }
  return publishSessionId
}
