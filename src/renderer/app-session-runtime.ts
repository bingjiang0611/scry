import { useMemo, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ProviderId } from '@shared/provider'
import type { useIntegrations } from './hooks/useIntegrations'
import type { SessionComposerDraft, SessionPromptQueues } from './app-model'
import { sessionComposerDraftKey, migrateSessionComposerDraft, migrateSessionPromptQueue, applyTurnDoneEffects } from './app-model'
import { recordedSessionModel } from './hooks/useIntegrations'
import { updateQueuedPromptByMessageId } from './steer'
import { latestSteerCapability, latestSteerEvidenceForTurns, type QueuedSteerState } from './steer'
import { useAgentSession as createAgentSession } from './hooks/useAgentSession'

export interface AppSessionRuntimeContext {
  activeSessionIdRef: MutableRefObject<string | null>
  localDraftOwnersRef: MutableRefObject<Map<string, { key: string; providerId: ProviderId; agentProfileId?: string; cwd: string | null }>>
  integrations: ReturnType<typeof useIntegrations>
  setSessionDrafts: (update: (drafts: ReadonlyMap<string, SessionComposerDraft>) => ReadonlyMap<string, SessionComposerDraft>) => void
  setSessionPromptQueues: Dispatch<SetStateAction<SessionPromptQueues>>
  migrateRightSurface: (from: string, to: string) => void
  markRunFinished: (runId: string) => void
  setWorkspaceRefreshKey: Dispatch<SetStateAction<number>>
  selectSessionId: (id: string | null) => void
  loadProjects: () => void | Promise<void>
  sessionLoading: boolean
  activeSessionId: string | null
  draftKey: string
}

export function useAppSessionRuntime(context: AppSessionRuntimeContext) {
  const { activeSessionIdRef, localDraftOwnersRef, integrations, setSessionDrafts, setSessionPromptQueues, migrateRightSurface,
    markRunFinished, setWorkspaceRefreshKey, selectSessionId, loadProjects, sessionLoading, activeSessionId, draftKey } = context

  const session = createAgentSession({
    onTurnDone: (event) => {
      const previousSessionId = activeSessionIdRef.current
      const draftOwner = localDraftOwnersRef.current.get(event.runId)
      // Some Providers surface their native session id only with turn:done. Preserve
      // drafts (and queued follow-ups) even if the user switched away before then.
      if (event.sessionId && draftOwner) {
        const capturedKey = sessionComposerDraftKey({ ...draftOwner, sessionId: event.sessionId })
        migrateRightSurface(draftOwner.key, capturedKey)
        integrations.migrateSessionModel(draftOwner.key, capturedKey)
        setSessionDrafts((current) => migrateSessionComposerDraft(current, draftOwner.key, capturedKey))
        setSessionPromptQueues((current) => migrateSessionPromptQueue(current, draftOwner.key, capturedKey, { runId: event.runId, externalSessionId: event.sessionId! }))
      }
      markRunFinished(event.runId)
      setWorkspaceRefreshKey((current) => current + 1)
      applyTurnDoneEffects(event, {
        activeSessionId: previousSessionId,
        setActiveSessionId: selectSessionId,
        refreshAfterTurn: integrations.refreshAfterTurn,
        loadProjects
      })
    },
    onError: (event) => {
      markRunFinished(event.runId)
      setWorkspaceRefreshKey((current) => current + 1)
      integrations.loadGitDiff()
      loadProjects()
    }
  })
  const steerEvidenceByMessageId = useMemo(
    () => latestSteerEvidenceForTurns(session.turns),
    [session.turns]
  )
  const activeSteerTurn = [...session.turns].reverse().find((turn) => !turn.done && !turn.error)
  const steerCapability = activeSteerTurn ? latestSteerCapability(activeSteerTurn.items) ?? null : null
  useEffect(() => {
    for (const [messageId, evidence] of steerEvidenceByMessageId) {
      setSessionPromptQueues((current) => updateQueuedPromptByMessageId(current, messageId, (prompt) => {
        if (evidence.status === 'accepted') return null
        if (prompt.steer?.status === 'unknown' || prompt.steer?.status === 'pending') return prompt
        if (evidence.status === 'pending' && prompt.steer) return prompt
        const next: QueuedSteerState = {
          status: evidence.status,
          ...(evidence.message ? { message: evidence.message } : {}),
          ...(evidence.providerTurnId ? { providerTurnId: evidence.providerTurnId } : {})
        }
        return prompt.steer?.status === next.status && prompt.steer?.message === next.message
          ? prompt
          : { ...prompt, steer: next }
      }))
    }
  }, [steerEvidenceByMessageId])
  useEffect(() => {
    if (activeSessionId == null || sessionLoading || integrations.hasSessionModel) return
    // Restore legacy/remote sessions from Scry's recorded request, not observed
    // token usage or the latest global preference. Explicit local choices win.
    const recorded = recordedSessionModel(session.turns)
    if (recorded) integrations.restoreSessionModel(draftKey, recorded)
  }, [activeSessionId, draftKey, integrations.hasSessionModel, integrations.restoreSessionModel, session.turns, sessionLoading])
  return { session, steerEvidenceByMessageId, steerCapability }
}
