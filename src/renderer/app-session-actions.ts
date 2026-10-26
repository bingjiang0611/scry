import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import { runStructuralTransition } from './structural-motion'
import { browserStorage } from './browser-storage'
import { persistSessionSelection, readStoredSessionSelection } from './session-restore'
import { workspaceRunSession } from './workspace-drafts'
import type { ProviderContext, ProviderId, SessionProviderId } from '@shared/provider'
import type { ProjectMeta, SessionMeta, SessionRef } from './env'
import type { Turn } from './format'
import type { AppView } from './app-types'
import type { useWorkspaceState } from './hooks/useWorkspaceState'
import type { useAgentSession } from './hooks/useAgentSession'
import type { useIntegrations } from './hooks/useIntegrations'
import type { SessionHistorySnapshotCache } from './session-history-cache'
import { sessionMatchesSelection, sessionSelectionChanged } from './session-selection'
import {
  activeRunForSession, applyNewConversationEffects, applySessionArchiveEffects, restoreActiveSessionSelection,
  buildForkSessionRequest, sessionEvidenceGapAfterLoad, sessionComposerDraftKey,
  type SessionEvidenceGap, type SessionPromptQueues
} from './app-model'

export function createSessionActions({
  workspace, session, integrations, setSessionLoading, sessionSelectionSeqRef,
  resetPromptQueueControl, shouldStickToBottomRef, selectSessionId, setView, taRef,
  draftContextRef, setSessionEvidenceGap, setSessionPromptQueues, setComposerError,
  confirmWorkspaceTransition, cwdRef, activeSessionIdRef, sessionLoading, sessionSnapshots,
  setSessionCacheVisible, requestChatBottom, selectedProviderSessionId, clearSessionPromptQueue,
  queueKeyRef, setArchiveUndo, archiveUndo, refreshProviderCatalogs
}: {
  workspace: ReturnType<typeof useWorkspaceState>
  session: ReturnType<typeof useAgentSession>
  integrations: ReturnType<typeof useIntegrations>
  setSessionLoading: Dispatch<SetStateAction<boolean>>
  sessionSelectionSeqRef: MutableRefObject<number>
  resetPromptQueueControl: () => void
  shouldStickToBottomRef: MutableRefObject<boolean>
  selectSessionId: (id: string | null) => void
  setView: Dispatch<SetStateAction<AppView>>
  taRef: RefObject<HTMLTextAreaElement>
  draftContextRef: MutableRefObject<{ providerId: ProviderId; agentProfileId: string | undefined; cwd: string | null }>
  setSessionEvidenceGap: Dispatch<SetStateAction<SessionEvidenceGap | null>>
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
  refreshProviderCatalogs: () => Promise<void>
}) {
  const { cwd, setCwd, loadProjects, refreshRecent } = workspace
  // 只记录“用户停在哪里”这一事实；会话内容、运行证据与权限仍需 pickSession 重新读取。
  const rememberSelection = (next: {
    cwd: string | null
    sessionId: string | null
    providerId: ProviderId
    externalSessionId?: string
    agentProfileId?: string
  }): void => {
    const target = next.cwd
    persistSessionSelection(target
      ? { cwd: target, sessionId: next.sessionId, providerId: next.providerId, externalSessionId: next.externalSessionId, agentProfileId: next.agentProfileId }
      : null, browserStorage())
  }
  const rememberWorkspaceOnly = (dir: string | null): void => rememberSelection({
    cwd: dir,
    sessionId: null,
    providerId: integrations.selectedProviderId,
    agentProfileId: integrations.providerContext.agentProfileId
  })
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
    window.setTimeout(() => taRef.current?.focus(), 0)
  }

  const newConversation = async (): Promise<void> => {
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    resetPromptQueueControl()
    shouldStickToBottomRef.current = true
    const pendingDraftKey = sessionComposerDraftKey({ ...draftContextRef.current, sessionId: null })
    // Reopen this workspace's unsent draft without discarding text or attachments.
    // Queued send intents are still reset below; restoring a draft never sends it.
    runStructuralTransition('session', () => {
      setSessionLoading(true)
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
      // 新建会话空态也要能被恢复：否则重载后会丢回“未选项目”。
      rememberWorkspaceOnly(cwd)
    })
    try {
      await window.scry.focusRun(null)
      if (!isCurrent()) return
      await applyNewConversationEffects({
        clearTurns: session.clearTurns,
        newSession: () => window.scry.newSession(integrations.providerContext),
        refreshProviderCatalogs,
        setActiveSessionId: selectSessionId,
        setView,
        focusComposer: () => window.setTimeout(() => taRef.current?.focus(), 0),
        isCurrent
      })
    } catch (error) {
      if (isCurrent()) setComposerError(`无法新建会话：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (isCurrent()) {
        setSessionLoading(false)
        window.setTimeout(() => taRef.current?.focus(), 0)
      }
    }
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
    agentProfileId?: string
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
    // Re-selecting an in-flight history must not invalidate its response or restart the main read.
    // The catalog row is selected before its body arrives; that is not a completed selection.
    if (!switchingSession && sessionLoading) return
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    setComposerError(null)
    setSessionEvidenceGap(null)
    const historyContext: ProviderContext = { providerId, agentProfileId, cwd: projectCwd, externalSessionId }
    const cacheRevision = sessionSnapshots.revision
    const cachedPage = switchingSession ? sessionSnapshots.get(historyContext) : undefined
    setSessionLoading(switchingSession || session.turns.length === 0)
    setSessionCacheVisible(Boolean(cachedPage?.turns.length))
    setView('chat')
    if (switchingSession) {
      if (cachedPage) session.replaceWithParsedSession(sessionId, cachedPage.turns, { activeRun: null, page: cachedPage, source: 'cache' })
      else session.clearTurns()
    }
    resetPromptQueueControl()
    requestChatBottom(true)
    selectSessionId(sessionId)
    setCwd(projectCwd || null)
    integrations.setSelectedId(agentProfileId ?? providerId)
    rememberSelection({ cwd: projectCwd || null, sessionId, providerId, externalSessionId, agentProfileId })
    try {
      // Sidebar activity is a display cache, not proof that no live run exists.
      const activeRunsRequest = window.scry.activeRuns()
      const [, activeRuns] = await Promise.all([
        window.scry.setCwd(projectCwd || null),
        activeRunsRequest
      ])
      if (!isCurrent()) return
      const runId = activeRunForSession(
        activeRuns,
        projectCwd,
        sessionId,
        providerId,
        agentProfileId
      )?.runId ?? knownRunId
      if (
        await restoreActiveSessionSelection(
          { runId, sessionId, externalSessionId, cwd: projectCwd, providerId, agentProfileId },
          {
            prepareRunFocus: session.prepareRunFocus,
            adoptActiveRun: (targetRunId) => window.scry.adoptActiveRun(targetRunId),
            loadSession: (context) => window.scry.loadSession(context),
            replaceWithParsedSession: session.replaceWithParsedSession,
            onHistoryLoaded: (page, activeRun) => {
              if (!isCurrent()) return
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
        if (isCurrent()) setSessionEvidenceGap(sessionEvidenceGapAfterLoad(sessionId, null))
        return
      }
      const [loadedPage] = await Promise.all([
        window.scry.loadSession(historyContext),
        focusRequest
      ])
      if (!isCurrent()) return
      setSessionCacheVisible(false)
      const page = loadedPage ? sessionSnapshots.put(historyContext, loadedPage, cacheRevision) : null
      if (!page) sessionSnapshots.delete(historyContext)
      // Confirm only an unchanged display-only installation. A focus/start/clear
      // supersedes it and must use the normal authoritative replacement.
      const cacheConfirmed = page != null && page === cachedPage && session.confirmCachedSession(sessionId, page)
      if (!cacheConfirmed) session.replaceWithParsedSession(sessionId, page?.turns ?? [], {
        activeRun: null,
        page
      })
      setSessionEvidenceGap(sessionEvidenceGapAfterLoad(sessionId, page))
    } catch (error) {
      if (isCurrent()) {
        setSessionEvidenceGap({
          sessionId,
          status: 'error',
          detail: `无法加载会话历史：${error instanceof Error ? error.message : String(error)}`
        })
        sessionSnapshots.delete(historyContext)
        setSessionCacheVisible(false)
        if (cachedPage) session.clearTurns()
        setComposerError(`无法打开对话：${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      if (isCurrent()) setSessionLoading(false)
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

  // 崩溃重载后的兜底恢复：没有仍在跑的轮次时，回到上一棵树停下的位置。
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

  // 置顶与存档都会让会话换分组，所以重新拉一次列表而不是就地改：顺序变化是预期结果。
  const togglePinSession = async (cwd: string, session: SessionMeta): Promise<void> => {
    await window.scry.setSessionPinned(sessionRefOf(cwd, session), !session.pinnedAt)
    workspace.loadProjects()
  }

  const renameSession = async (cwd: string, session: SessionMeta, title: string): Promise<void> => {
    if (!window.scry.renameSession) throw new Error('请重启 Scry 以启用会话重命名')
    const changed = await window.scry.renameSession(sessionRefOf(cwd, session), title)
    if (!changed) throw new Error('会话已不存在或身份已变化，请刷新列表后重试')
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
    await applySessionArchiveEffects({
      archive: () => window.scry.setSessionArchived(ref, true),
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
