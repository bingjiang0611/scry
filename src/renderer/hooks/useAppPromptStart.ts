import { useCallback } from 'react'
import type { AgentInputAttachment, AgentStartRequest } from '@shared/runtime'
import type { AppComposerContext } from '../app-composer'
import { migrateSessionPromptQueue, sessionComposerDraftKey } from '../app-model'
import { consumeWorkspaceDraft, workspaceForFirstSend, workspaceRunSession } from '../workspace-drafts'
import { workspaceCopy } from '../constants/workspace-copy'

export function useAppPromptStart(
  context: AppComposerContext,
  currentRunRequest: () => Omit<AgentStartRequest, 'prompt' | 'attachments'>
) {
  const {
    chatNavigation, draftStore, draftKey, draftContextRef, sessionSelectionSeqRef,
    session, integrations, cwdRef, activeSessionIdRef, selectSessionId, setCwd, loadProjects,
    localDraftOwnersRef, localRunIdsRef, localStartsRef, migrateRightSurface,
    setSessionPromptQueues, setComposerError, openWorkspaceRun
  } = context

  return useCallback(async (
    text: string,
    attachments: AgentInputAttachment[] = [],
    request = currentRunRequest(),
    sourceDraftKey = draftKey
  ): Promise<void> => {
    chatNavigation.cancel()
    const sourceContext = draftContextRef.current
    const sourceCwd = request.cwd ?? sourceContext.cwd
    const selectionSequence = sessionSelectionSeqRef.current
    const submittedDraft = draftStore.getSnapshot().get(sourceDraftKey)
    const workspace = workspaceForFirstSend(submittedDraft?.workspace, request)
    const started = await session.send(text, {
      ...request, attachments, ...(workspace ? { workspace } : {})
    })
    if (!started) return
    const { runId } = started
    if (started.workspace) request = { ...request, cwd: started.workspace.cwd }
    const expectedSessionId = request.expectedExternalSessionId
    const ownerSessionId = started.workspace ? started.externalSessionId ?? runId : runId
    const draftOwner = {
      key: expectedSessionId === null
        ? sessionComposerDraftKey({
          providerId: request.providerId ?? sourceContext.providerId,
          agentProfileId: request.agentProfileId,
          cwd: request.cwd ?? null,
          sessionId: ownerSessionId
        })
        : sourceDraftKey,
      providerId: request.providerId ?? sourceContext.providerId,
      agentProfileId: request.agentProfileId,
      cwd: request.cwd ?? null
    }
    integrations.rememberSessionModel(draftOwner.key, request)
    localDraftOwnersRef.current.set(runId, draftOwner)
    localRunIdsRef.current.add(runId)
    while (localRunIdsRef.current.size > 64) {
      const oldest = localRunIdsRef.current.values().next().value
      if (oldest === undefined) break
      localRunIdsRef.current.delete(oldest)
    }

    if (!started.workspace) {
      migrateRightSurface(sourceDraftKey, draftOwner.key)
      if (expectedSessionId === null && cwdRef.current === (request.cwd ?? null)) selectSessionId(runId)
      if (expectedSessionId && activeSessionIdRef.current === expectedSessionId) {
        localStartsRef.current.set(runId, expectedSessionId)
        while (localStartsRef.current.size > 64) {
          const oldest = localStartsRef.current.keys().next().value
          if (oldest === undefined) break
          localStartsRef.current.delete(oldest)
        }
      }
      return
    }

    loadProjects()
    const prepared = started.workspace
    const currentContext = draftContextRef.current
    const currentChoice = draftStore.getSnapshot().get(sourceDraftKey)?.workspace
    const ownsSelection = sessionSelectionSeqRef.current === selectionSequence &&
      cwdRef.current === sourceCwd && currentContext.providerId === draftOwner.providerId &&
      currentContext.agentProfileId === draftOwner.agentProfileId &&
      currentChoice && !('invalid' in currentChoice) && currentChoice.operationId === prepared.operationId

    draftStore.update(current => consumeWorkspaceDraft(
      current, sourceDraftKey, prepared.operationId, ownsSelection ? draftOwner.key : undefined, submittedDraft
    ))
    setSessionPromptQueues(current => migrateSessionPromptQueue(current, sourceDraftKey, draftOwner.key, {
      runId, externalSessionId: ownerSessionId, cwd: prepared.cwd
    }))
    if (!ownsSelection) return

    migrateRightSurface(sourceDraftKey, draftOwner.key)
    cwdRef.current = prepared.cwd
    setCwd(prepared.cwd)
    selectSessionId(ownerSessionId)
    const isCurrent = () => sessionSelectionSeqRef.current === selectionSequence && cwdRef.current === prepared.cwd
    try {
      await window.scry.setCwd(prepared.cwd)
      if (!isCurrent()) return
      const adopted = await session.adoptStartedRun(runId)
      if (!isCurrent() || adopted.status === 'superseded') return
      const externalSessionId = adopted.status === 'focused' ? adopted.run.externalSessionId
        : await workspaceRunSession({
          providerId: draftOwner.providerId, agentProfileId: draftOwner.agentProfileId, cwd: prepared.cwd
        }, runId)
      if (!isCurrent()) return
      if (externalSessionId && externalSessionId !== ownerSessionId) {
        const key = sessionComposerDraftKey({ ...draftOwner, sessionId: externalSessionId })
        integrations.migrateSessionModel(draftOwner.key, key)
        migrateRightSurface(draftOwner.key, key)
        draftStore.update(current => {
          const draft = current.get(draftOwner.key)
          if (!draft || current.has(key)) return current
          const next = new Map(current)
          next.delete(draftOwner.key)
          next.set(key, draft)
          return next
        })
        setSessionPromptQueues(current => migrateSessionPromptQueue(current, draftOwner.key, key, {
          runId, externalSessionId, cwd: prepared.cwd
        }))
        localDraftOwnersRef.current.set(runId, { ...draftOwner, key })
        selectSessionId(externalSessionId)
      }
      if (adopted.status === 'unavailable') await openWorkspaceRun(prepared.cwd, externalSessionId!, runId)
    } catch (error) {
      if (isCurrent()) setComposerError(workspaceCopy.boundError(error instanceof Error ? error.message : String(error)))
    }
  }, [
    chatNavigation.cancel, currentRunRequest, draftKey, draftStore, draftContextRef, sessionSelectionSeqRef,
    session.send, session.adoptStartedRun, integrations.rememberSessionModel, integrations.migrateSessionModel,
    cwdRef, activeSessionIdRef, selectSessionId, setCwd, loadProjects, localDraftOwnersRef, localRunIdsRef, localStartsRef,
    migrateRightSurface, setSessionPromptQueues, setComposerError, openWorkspaceRun
  ])
}
