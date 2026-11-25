import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import { patchProjectSession, sessionRowKey, type SessionSaveState } from './session-save-state'
import { actionErrorText } from './hooks/useAsyncAction'
import { LOADING_COPY, SESSION_EMPTY_COPY, SESSION_SAVE_COPY } from './constants/copy'
import { runStructuralTransition } from './structural-motion'
import { browserStorage } from './browser-storage'
import { persistSessionSelection, readStoredSessionSelection } from './session-restore'
import { workspaceRunSession } from './workspace-drafts'
import type { ProviderContext, ProviderId, SessionProviderId } from '@shared/provider'
import type { ProjectMeta, SessionMeta, SessionRef } from './env'
import type { Turn } from './format'
import type { AppView } from './app-types'
import type { useWorkspaceState } from './hooks/useWorkspaceState'
import type { useAppSessionRuntime } from './app-session-runtime'
import type { useIntegrations } from './hooks/useIntegrations'
import type { SessionHistorySnapshotCache } from './session-history-cache'
import { sessionMatchesSelection, sessionSelectionChanged } from './session-selection'
import { sessionPreviewPage } from './session-preview'
import {
  activeRunForSession, applyNewConversationEffects, applySessionArchiveEffects, restoreActiveSessionSelection,
  buildForkSessionRequest, sessionEvidenceGapAfterLoad, sessionComposerDraftKey,
  type SessionEvidenceGap, type SessionPromptQueues
} from './app-model'
import { focusComposerUnlessFocusMoved } from './composer-focus'

const SAVED_STATUS_MS = 1200

export function createSessionActions({
  workspace, session, integrations, setSessionLoading, sessionSelectionSeqRef, sessionNavigationSeqRef,
  resetPromptQueueControl, shouldStickToBottomRef, selectSessionId, setView, taRef,
  draftContextRef, setSessionEvidenceGap, setMissingWorkspaceSessionId, setSessionPromptQueues, setComposerError,
  confirmWorkspaceTransition, cwdRef, activeSessionIdRef, sessionLoading, sessionSnapshots,
  setSessionCacheVisible, requestChatBottom, selectedProviderSessionId, clearSessionPromptQueue,
  queueKeyRef, setArchiveUndo, archiveUndo, refreshProviderCatalogs, setSessionSaves
}: {
  workspace: ReturnType<typeof useWorkspaceState>
  session: ReturnType<typeof useAppSessionRuntime>['session']
  integrations: ReturnType<typeof useIntegrations>
  setSessionLoading: Dispatch<SetStateAction<boolean>>
  sessionSelectionSeqRef: MutableRefObject<number>
  sessionNavigationSeqRef: MutableRefObject<number>
  resetPromptQueueControl: () => void
  shouldStickToBottomRef: MutableRefObject<boolean>
  selectSessionId: (id: string | null) => void
  setView: Dispatch<SetStateAction<AppView>>
  taRef: RefObject<HTMLTextAreaElement>
  draftContextRef: MutableRefObject<{ providerId: ProviderId; agentProfileId: string | undefined; cwd: string | null }>
  setSessionEvidenceGap: Dispatch<SetStateAction<SessionEvidenceGap | null>>
  setMissingWorkspaceSessionId: (sessionId: string | null) => void
  setSessionPromptQueues: Dispatch<SetStateAction<SessionPromptQueues>>
  setComposerError: Dispatch<SetStateAction<string | null>>
  confirmWorkspaceTransition: () => boolean
  cwdRef: MutableRefObject<string | null>
  activeSessionIdRef: MutableRefObject<string | null>
  sessionLoading: boolean
  sessionSnapshots: SessionHistorySnapshotCache
  setSessionCacheVisible: Dispatch<SetStateAction<boolean>>
  requestChatBottom: (preserveDuringSessionOpen?: boolean) => void
  selectedProviderSessionId: string | null
  clearSessionPromptQueue: (key?: string) => void
  queueKeyRef: MutableRefObject<string>
  setArchiveUndo: Dispatch<SetStateAction<{ ref: SessionRef; preview: string } | null>>
  archiveUndo: { ref: SessionRef; preview: string } | null
  setSessionSaves: Dispatch<SetStateAction<ReadonlyMap<string, SessionSaveState>>>
  refreshProviderCatalogs: () => Promise<void>
}) {
  const { cwd, setCwd, loadProjects, refreshRecent } = workspace
  const rememberWorkspaceOnly = (dir: string | null): void => persistSessionSelection(dir ? {
    cwd: dir,
    sessionId: null,
    providerId: integrations.selectedProviderId,
    agentProfileId: integrations.providerContext.agentProfileId
  } : null, browserStorage())
  const pickRecent = async (dir: string): Promise<void> => {
    if (dir === cwd) return
    setSessionLoading(false)
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    await window.scry.focusRun(null)
    if (!isCurrent()) return
    await window.scry.setCwd(dir)
    if (!isCurrent()) return
    setCwd(dir)
    session.clearTurns()
    resetPromptQueueControl()
    shouldStickToBottomRef.current = true
    selectSessionId(null)
    setView('chat')
    rememberWorkspaceOnly(dir)
  }

  const unbindProject = async (): Promise<void> => {
    if (!cwd) return
    const focusBefore = document.activeElement
    setSessionLoading(false)
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    await window.scry.focusRun(null)
    if (!isCurrent()) return
    await window.scry.setCwd(null)
    if (!isCurrent()) return
    setCwd(null)
    session.clearTurns()
    resetPromptQueueControl()
    shouldStickToBottomRef.current = true
    selectSessionId(null)
    setView('chat')
    persistSessionSelection(null, browserStorage())
    focusComposerUnlessFocusMoved(taRef, focusBefore)
  }

  const newConversation = async (): Promise<void> => {
    const focusBefore = document.activeElement
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    resetPromptQueueControl()
    shouldStickToBottomRef.current = true
    const pendingDraftKey = sessionComposerDraftKey({ ...draftContextRef.current, sessionId: null })
    runStructuralTransition('session', () => {
      setSessionLoading(true)
      setSessionCacheVisible(false)
      setSessionEvidenceGap(null)
      selectSessionId(null)
      setSessionPromptQueues((current) => {
        if (!current.has(pendingDraftKey)) return current
        const next = new Map(current)
        next.delete(pendingDraftKey)
        return next
      })
      session.clearTurns()
      setView('chat')
      rememberWorkspaceOnly(cwd)
    })
    try {
      await window.scry.focusRun(null)
      if (!isCurrent()) return
      await applyNewConversationEffects({
        clearTurns: session.clearTurns,
        newSession: () => window.scry.newSession(integrations.providerContext),
        setActiveSessionId: selectSessionId,
        setView,
        focusComposer: () => focusComposerUnlessFocusMoved(taRef, focusBefore),
        isCurrent
      })
    } catch (error) {
      if (isCurrent()) setComposerError(`无法新建会话：${error instanceof Error ? error.message : String(error)}`)
      return
    } finally {
      if (isCurrent()) {
        setSessionLoading(false)
        focusComposerUnlessFocusMoved(taRef, focusBefore)
      }
    }
    if (isCurrent()) void refreshProviderCatalogs()
  }

  const newConversationInProject = async (projectCwd: string): Promise<void> => {
    if (projectCwd === cwd) await newConversation()
    else await pickRecent(projectCwd)
  }

  const toggleProjectPin = async (project: ProjectMeta): Promise<void> => {
    if (await window.scry.setProjectPinned(project.cwd, !project.pinnedAt)) loadProjects()
  }

  const renameProject = async (project: ProjectMeta, name: string): Promise<void> => {
    if (await window.scry.renameProject(project.cwd, name)) loadProjects()
  }

  const removeProject = async (project: ProjectMeta): Promise<void> => {
    if (project.cwd === cwd && !confirmWorkspaceTransition()) return
    await window.scry.removeProject(project.cwd)
    if (project.cwd === cwd) await unbindProject()
    refreshRecent()
    loadProjects()
  }

  const pickSession = async (
    projectCwd: string,
    sessionId: string,
    providerId: SessionProviderId,
    externalSessionId?: string,
    knownRunId?: string,
    agentProfileId?: string,
    previewText?: string,
    previewRunId?: string
  ): Promise<void> => {
    if (providerId === 'legacy_unknown') return
    const switchingSession = sessionSelectionChanged(
      {
        cwd: cwdRef.current,
        sessionId: activeSessionIdRef.current,
        providerId: integrations.selectedProviderId,
        agentProfileId: integrations.providerContext.agentProfileId
      },
      {
        cwd: projectCwd,
        sessionId,
        externalSessionId,
        runId: knownRunId,
        providerId,
        agentProfileId
      }
    )
    sessionNavigationSeqRef.current += 1
    if (!switchingSession && sessionLoading) return
    setComposerError(null)
    const historyContext: ProviderContext = { providerId, agentProfileId, cwd: projectCwd, externalSessionId }
    const cacheRevision = sessionSnapshots.revision
    const cachedPage = switchingSession ? sessionSnapshots.get(historyContext) : undefined
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    const presentationPage = cachedPage ?? (switchingSession ? sessionPreviewPage(sessionId, previewText, previewRunId) : undefined)
    setSessionEvidenceGap(previous => !switchingSession && previous?.sessionId === sessionId && previous.status === 'error' ? previous : null)
    setSessionLoading(true)
    setSessionCacheVisible(Boolean(presentationPage?.turns.length) || (!switchingSession && session.turns.length > 0))
    setView('chat')
    if (switchingSession) {
      if (presentationPage) session.replaceWithParsedSession(sessionId, presentationPage.turns, { activeRun: null, page: presentationPage, source: 'cache' })
      else session.clearTurns()
    }
    resetPromptQueueControl()
    requestChatBottom(true)
    selectSessionId(sessionId)
    setCwd(projectCwd || null)
    integrations.setSelectedId(agentProfileId ?? providerId)
    persistSessionSelection(projectCwd ? { cwd: projectCwd, sessionId, providerId, externalSessionId, agentProfileId } : null, browserStorage())
    try {
      const activeRunsRequest = window.scry.activeRuns()
      const [selectedCwd, activeRuns] = await Promise.all([
        window.scry.setCwd(projectCwd || null, true),
        activeRunsRequest
      ])
      if (!isCurrent()) return
      const workspaceMissing = Boolean(projectCwd) && selectedCwd === null
      setMissingWorkspaceSessionId(workspaceMissing ? sessionId : null)
      const runId = activeRunForSession(
        activeRuns,
        projectCwd,
        sessionId,
        providerId,
        agentProfileId
      )?.runId ?? knownRunId
      let adoptionFailed = false
      if (
        !workspaceMissing && await restoreActiveSessionSelection(
          { runId, sessionId, externalSessionId, cwd: projectCwd, providerId, agentProfileId },
          {
            prepareRunFocus: session.prepareRunFocus,
            adoptActiveRun: async (targetRunId) => {
              try {
                return await window.scry.adoptActiveRun(targetRunId)
              } catch (error) {
                console.warn('[Scry] active run adoption failed', error)
                adoptionFailed = true
                return null
              }
            },
            loadSession: (context) => window.scry.loadSession(context),
            replaceWithParsedSession: session.replaceWithParsedSession,
            onHistoryLoaded: (page, activeRun) => {
              if (!isCurrent()) return
              if (page?.workspaceMissing) setMissingWorkspaceSessionId(sessionId)
              setSessionCacheVisible(false)
              if (page && activeRun?.done !== false) sessionSnapshots.put(historyContext, page, cacheRevision)
              else sessionSnapshots.delete(historyContext)
              setSessionEvidenceGap(sessionEvidenceGapAfterLoad(sessionId, page, activeRun))
            },
            isCurrent
          }
        )
      ) {
        return
      }
      if (!isCurrent()) return
      const focusRequest = window.scry.focusRun(null)
      if (!externalSessionId) {
        await focusRequest
        if (isCurrent()) {
          setSessionEvidenceGap(sessionEvidenceGapAfterLoad(sessionId, null))
          if (adoptionFailed) setComposerError(LOADING_COPY.sessionAdoptFailed)
        }
        return
      }
      const [loadedPage] = await Promise.all([
        window.scry.loadSession(historyContext),
        focusRequest
      ])
      if (!isCurrent()) return
      if (loadedPage?.workspaceMissing) setMissingWorkspaceSessionId(sessionId)
      setSessionCacheVisible(false)
      const page = loadedPage ? sessionSnapshots.put(historyContext, loadedPage, cacheRevision) : null
      if (!page) sessionSnapshots.delete(historyContext)
      const cacheConfirmed = page != null && page === cachedPage && session.confirmCachedSession(sessionId, page)
      const finishPresentation = (): void => {
        setSessionEvidenceGap(sessionEvidenceGapAfterLoad(sessionId, page))
        setSessionLoading(false)
      }
      if (cacheConfirmed) finishPresentation()
      else session.replaceWithParsedSession(sessionId, page?.turns ?? [], { activeRun: null, page }, finishPresentation)
      if (adoptionFailed) setComposerError(LOADING_COPY.sessionAdoptFailed)
    } catch (error) {
      if (isCurrent()) {
        console.error('[Scry] session history read failed', error)
        setSessionEvidenceGap({ sessionId, status: 'error', detail: SESSION_EMPTY_COPY.readFailedDetail })
        sessionSnapshots.delete(historyContext)
        setSessionCacheVisible(false)
        if (presentationPage) session.clearTurns()
      }
    } finally {
      if (isCurrent()) {
        setSessionCacheVisible(false)
        setSessionLoading(false)
      }
    }
  }

  const openWorkspaceRun = async (target: string, sessionId: string, runId = sessionId): Promise<void> => {
    const seq = sessionSelectionSeqRef.current
    const providerId = integrations.selectedProviderId
    const agentProfileId = integrations.providerContext.agentProfileId
    const nativeId = sessionId === runId
      ? await workspaceRunSession({ providerId, agentProfileId, cwd: target }, runId) : sessionId
    if (seq !== sessionSelectionSeqRef.current) return
    await pickSession(target, nativeId, providerId, nativeId, runId, agentProfileId)
  }

  const forkConversationTurn = async (turn: Turn): Promise<void> => {
    const providerId = integrations.selectedProviderId
    const sourceSessionId = session.historyWindow?.sessionId ?? selectedProviderSessionId
    const sourceProviderTurnId = turn.providerTurnId
    const sourceForkTurnId = turn.forkTurnId ?? sourceProviderTurnId
    if (!sourceSessionId || !sourceProviderTurnId || !sourceForkTurnId) {
      throw new Error('当前轮次缺少可验证的 Provider 会话边界')
    }
    const forked = await window.scry.forkSession(buildForkSessionRequest({
      providerId,
      cwd: cwd ?? undefined,
      sourceSessionId,
      sourceRunId: turn.runId,
      sourceProviderTurnId,
      sourceForkTurnId,
      model: integrations.runControls.model,
      permissionMode: integrations.runControls.permissionMode
    }, integrations.providerContext.agentProfileId))
    loadProjects()
    await pickSession(
      cwd ?? '',
      forked.externalSessionId,
      providerId,
      forked.externalSessionId,
      undefined,
      integrations.providerContext.agentProfileId
    )
  }

  const restoreLastSelection = async (): Promise<void> => {
    const stored = readStoredSessionSelection(browserStorage())
    if (!stored) return
    if (!stored.sessionId) {
      await pickRecent(stored.cwd)
      return
    }
    await pickSession(stored.cwd, stored.sessionId, stored.providerId, stored.externalSessionId, undefined, stored.agentProfileId)
  }

  const sessionRefOf = (cwd: string, session: SessionMeta): SessionRef => ({
    providerId: session.providerId,
    agentProfileId: session.agentProfileId,
    cwd,
    externalSessionId: session.externalSessionId ?? session.sessionId
  })

  const markSave = (key: string, state: SessionSaveState | null): void => {
    setSessionSaves((current) => {
      const next = new Map(current)
      if (state) next.set(key, state)
      else next.delete(key)
      return next
    })
    if (state?.status === 'saved') {
      setTimeout(() => setSessionSaves((current) => {
        if (current.get(key) !== state) return current
        const next = new Map(current)
        next.delete(key)
        return next
      }), SAVED_STATUS_MS)
    }
  }

  const togglePinSession = async (cwd: string, session: SessionMeta): Promise<void> => {
    const key = sessionRowKey(cwd, session)
    const pinned = !session.pinnedAt
    workspace.setProjects((current) => patchProjectSession(current, cwd, session, { pinnedAt: pinned ? Date.now() : undefined }))
    markSave(key, { status: 'saving', action: 'pin' })
    try {
      if (!(await window.scry.setSessionPinned(sessionRefOf(cwd, session), pinned))) throw new Error(SESSION_SAVE_COPY.gone)
      markSave(key, { status: 'saved', action: 'pin' })
    } catch (error) {
      workspace.setProjects((current) => patchProjectSession(current, cwd, session, { pinnedAt: session.pinnedAt }))
      markSave(key, { status: 'failed', action: 'pin', reason: actionErrorText(error, SESSION_SAVE_COPY.pinFailed) })
    }
    workspace.loadProjects()
  }

  const renameSession = async (cwd: string, session: SessionMeta, title: string): Promise<void> => {
    if (!window.scry.renameSession) throw new Error('请重启 Scry 以启用会话重命名')
    workspace.setProjects((current) => patchProjectSession(current, cwd, session, { preview: title }))
    try {
      const changed = await window.scry.renameSession(sessionRefOf(cwd, session), title)
      if (!changed) throw new Error('会话已不存在或身份已变化，请刷新列表后重试')
    } catch (error) {
      workspace.setProjects((current) => patchProjectSession(current, cwd, session, { preview: session.preview }))
      throw error
    }
    workspace.loadProjects()
  }

  const archiveSession = async (cwd: string, meta: SessionMeta): Promise<void> => {
    const selectionSeq = sessionSelectionSeqRef.current
    const ref = sessionRefOf(cwd, meta)
    const archivingActiveSession = sessionMatchesSelection(cwd, meta, {
      cwd: cwdRef.current,
      sessionId: activeSessionIdRef.current,
      providerId: integrations.selectedProviderId,
      agentProfileId: integrations.providerContext.agentProfileId
    })
    if (ref.providerId !== 'legacy_unknown') clearSessionPromptQueue(archivingActiveSession ? queueKeyRef.current : sessionComposerDraftKey({
      providerId: ref.providerId, agentProfileId: ref.agentProfileId, cwd, sessionId: meta.sessionId
    }))
    const key = sessionRowKey(cwd, meta)
    workspace.setProjects((current) => patchProjectSession(current, cwd, meta, null))
    markSave(key, { status: 'saving', action: 'archive' })
    await applySessionArchiveEffects({
      archive: async () => {
        try {
          if (!(await window.scry.setSessionArchived(ref, true))) throw new Error(SESSION_SAVE_COPY.gone)
        } catch (error) {
          markSave(key, { status: 'failed', action: 'archive', reason: actionErrorText(error, SESSION_SAVE_COPY.archiveFailed) })
          workspace.loadProjects()
          return false
        }
        markSave(key, null)
        return true
      },
      archivingActiveSession,
      rememberUndo: () => setArchiveUndo({ ref, preview: meta.preview }),
      resetConversation: async () => {
        if (selectionSeq === sessionSelectionSeqRef.current) await newConversation()
      },
      reloadProjects: workspace.loadProjects
    })
  }

  const undoArchive = async (): Promise<void> => {
    if (!archiveUndo) return
    const pending = archiveUndo
    await window.scry.setSessionArchived(pending.ref, false)
    setArchiveUndo((current) => current === pending ? null : current)
    workspace.loadProjects()
  }
  return {
    pickRecent, unbindProject, newConversation, newConversationInProject,
    toggleProjectPin, renameProject, removeProject, pickSession, openWorkspaceRun, forkConversationTurn,
    togglePinSession, renameSession, archiveSession, undoArchive, restoreLastSelection
  }
}
