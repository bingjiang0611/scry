import type { AppViewContext } from './app-view-types'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { TurnDiffSnapshot } from '@shared/trace'
import type { ConversationSummary } from '@shared/conversation-api'
import type { RemoteSessionRef } from '@shared/desktop-remote'
import type { AppView, AppStyle } from './app-types'
import type { ExecutionLocation } from './components/LocationPicker'
import type { RightSurfaceAction } from './right-surface'
import { appendMetaPrompt } from './meta-prompts'
import { composerDraftKey } from './composer-drafts'
import { usePinnedSummaryVisibility } from './components/PinnedSummary'
import { LocationPicker } from './components/LocationPicker'
import { remoteDraftKey } from './components/RemoteChat'
import { sessionComposerDraftKey, migrateSessionComposerDraft, updateSessionComposerDraft, hasSessionOverviewContext, latestSessionRuntimeProvider } from './app-model'
import { runtimeProviderForAgentId } from '@shared/runtime'
import { applyTheme, browserThemeStorage, persistTheme, type AppTheme } from './theme'
import { adoptConversationWithReadback, conversationTarget } from './conversation-handoff'
import { useDiffInspector, useNarrowDiffLayout } from './hooks/useDiffInspector'
import { useWorkspaceSelection } from './hooks/useWorkspaceSelection'
import { WorkspaceContext } from './components/WorkspacePicker'
import type { DiffReviewSelection } from './hooks/useDiffReviewSelection'
import { runStructuralTransition } from './structural-motion'
import { animatePaneChange, cancelPaneMotion } from './pane-motion'

export function useAppView(context: AppViewContext) {
  const { setTheme, setShowSkills, setShowMcp, setShowLlmPerformance, refreshProviderCatalogs,
    view, viewRef, setView, cwd, setCwd, activeSessionId, selectSessionId, session, integrations, sessionLoading, composerSubmitting,
    switchingAgentRef, setSwitchingAgent, setComposerError, draftAttachments, queuedPrompts, draftKey, draftStore, setInput,
    releaseDraft, selectedProviderSessionId, sessionSelectionSeqRef, activeSessionIdRef, cwdRef, setSessionDrafts, migrateRightSurface,
    loadProjects, recent, chooseFolder, removeRecentFolder, confirmWorkspaceTransition, logicalConversation, conversationProjection,
    sessionEvidenceGap, setConversationError, setConversationAgent, setLogicalConversation, remoteWorkspaceDirty, setRemoteWorkspaceDirty,
    remoteTarget, setRemoteTarget, setRemoteAdoptedSession, sidebarPane, surfacePane, rightSurfaces, rightSurface,
    hasSurfaceContext, terminalOpen, remoteSurface, remotePanelVisible, remoteSurfaceKey, currentSurface, dispatchRightSurface,
    setTurnDiffSelection, setWorkspaceDirty, setSettingsTab, newConversation, unbindProject, pickRecent, setSessionLoading,
    turnDiffSelection, taRef, setSlashHidden, workspaceRefreshKey } = context

  const openLlmPerformance = (): void => {
    setShowSkills(false)
    setShowMcp(false)
    setShowLlmPerformance(true)
  }
  const openSkills = (): void => {
    setShowLlmPerformance(false)
    setShowMcp(false)
    setShowSkills(true)
    void refreshProviderCatalogs()
  }
  const openMcp = (): void => {
    setShowLlmPerformance(false)
    setShowSkills(false)
    setShowMcp(true)
    if (!integrations.mcpCapability) void integrations.refreshMcp().catch(() => { })
  }
  const changeTheme = (nextTheme: AppTheme): void => {
    cancelPaneMotion()
    runStructuralTransition('theme', () => {
      setTheme(nextTheme)
      applyTheme(nextTheme, document.documentElement)
      persistTheme(nextTheme, browserThemeStorage())
    })
  }

  const appStyle: AppStyle = {
    '--sidebar-w': `${sidebarPane.visibleWidth}px`,
    '--overview-panel-w': `${surfacePane.visibleWidth}px`
  }
  const mountedSurfaces = rightSurfaces.surfaces.some((surface) => surface.id === currentSurface.id)
    ? rightSurfaces.surfaces : [...rightSurfaces.surfaces, currentSurface]
  const rightPanelMounted = hasSurfaceContext || rightSurface.visible || terminalOpen || rightSurfaces.surfaces.length > 0
  const panelVisible = rightPanelMounted && (view === 'chat' || view === 'conversation') && rightSurface.visible && !surfacePane.collapsed
  const shellPanelMounted = rightPanelMounted || view === 'remote'
  const shellPanelVisible = view === 'remote' ? remotePanelVisible : panelVisible
  const narrowDiff = useNarrowDiffLayout()
  const shellPanelMaximized = shellPanelVisible && (view === 'remote'
    ? remoteSurface.maximized : rightSurface.maximized || (narrowDiff && rightSurface.activeId === 'diff'))
  const pinnedSummary = usePinnedSummaryVisibility(view === 'chat' || view === 'conversation', panelVisible)
  const summaryPersistent = pinnedSummary.persistent
  const summaryVisible = pinnedSummary.visible
  const workspaceCwd = view === 'conversation' ? logicalConversation?.cwd ?? null : cwd
  const workspaceSelection = useWorkspaceSelection({
    cwd: workspaceCwd, draftKey, draftStore, selectionEpoch: sessionSelectionSeqRef.current,
    editable: view === 'chat' && !activeSessionId,
    active: view === 'chat' || view === 'conversation',
    busy: sessionLoading || composerSubmitting || session.busy
  })
  const workspaceContext = <WorkspaceContext controller={workspaceSelection} cwd={workspaceCwd}
    onOpenRun={(target, runId) => {
      void context.openWorkspaceRun(target, runId).catch(error => setComposerError(String(error)))
    }} />

  const displayedTurns = view === 'conversation'
    ? conversationProjection?.conversationId === logicalConversation?.id ? conversationProjection?.turns ?? [] : []
    : session.turns
  const displayedBusy = view === 'conversation' ? conversationProjection?.conversationId === logicalConversation?.id && conversationProjection?.busy === true : session.busy
  const panelRuntimeProvider = useMemo(
    () => latestSessionRuntimeProvider(displayedTurns) ?? runtimeProviderForAgentId(integrations.selectedId) ?? 'claude_sdk',
    [integrations.selectedId, displayedTurns]
  )
  // 只对当前选中且真的没有轮次的会话报证据缺失：新轮次一开始或切回新会话就自动消失。
  const activeEvidenceGap = session.turns.length === 0 && !session.busy &&
    activeSessionId != null && sessionEvidenceGap?.sessionId === activeSessionId
    ? sessionEvidenceGap
    : null
  const showSessionOverview = hasSessionOverviewContext(
    view === 'conversation' ? logicalConversation?.id ?? null : selectedProviderSessionId,
    displayedTurns.length,
    displayedBusy
  )
  const toggleOverviewPanel = (): void => {
    if (view !== 'chat' && view !== 'conversation') return
    animatePaneChange(() => {
      if (!rightSurface.visible || surfacePane.collapsed) {
        surfacePane.restore()
        dispatchRightSurface({ type: 'show' })
        return
      }
      dispatchRightSurface({ type: 'hide' })
    })
  }
  const changeView = (next: AppView): boolean => {
    if (view === 'remote' && next !== 'remote' && remoteWorkspaceDirty && !window.confirm('当前远程文件有未保存修改。放弃修改并继续吗？')) return false
    setRemoteWorkspaceDirty(false)
    cancelPaneMotion()
    runStructuralTransition('page', () => setView(next))
    if (next === 'analytics') integrations.loadAnalytics()
    return true
  }
  const pickConversation = (conversation: ConversationSummary): void => {
    if (!confirmWorkspaceTransition() || !changeView('conversation')) return
    sessionSelectionSeqRef.current += 1
    selectSessionId(null)
    setCwd(conversation.cwd)
    setConversationError(undefined)
    setConversationAgent(undefined)
    setLogicalConversation(conversation)
  }
  const selectChatAgent = (agentId: string): void => {
    if (switchingAgentRef.current) return
    if (view === 'conversation') { integrations.setSelectedId(agentId); return }
    if (composerSubmitting || session.busy || sessionLoading) return
    if (!activeSessionId && session.turns.length === 0) { integrations.setSelectedId(agentId); return }
    if (agentId === integrations.selectedId) return
    if (!cwd || !activeSessionId) { setComposerError('此轮缺少原生会话标识，无法安全交接；请先新建对话'); return }
    if (draftAttachments.length || queuedPrompts.length) { setComposerError('请先处理附件或待发送队列；切换不会丢弃它们'); return }
    const sourceKey = draftKey
    const sourceSessionId = activeSessionId
    const sourceCwd = cwd
    const sequence = sessionSelectionSeqRef.current
    switchingAgentRef.current = sourceKey
    setSwitchingAgent(true)
    setComposerError(null)
    void (async () => {
      try {
        const sourceTarget = conversationTarget(integrations.selectedId)
        const destination = conversationTarget(agentId)
        const source = {
          providerId: sourceTarget.providerId as 'claude' | 'codex' | 'pi',
          ...(sourceTarget.agentProfileId ? { agentProfileId: sourceTarget.agentProfileId } : {}),
          cwd: sourceCwd, externalSessionId: selectedProviderSessionId ?? sourceSessionId
        }
        const preview = await window.scry.conversations.previewAdoption(source, destination)
        // Navigation while planning cancels before any ownership write.
        if (viewRef.current !== 'chat' || sequence !== sessionSelectionSeqRef.current || activeSessionIdRef.current !== sourceSessionId || cwdRef.current !== sourceCwd) return
        const adopted = await adoptConversationWithReadback(window.scry.conversations, preview)
        const targetKey = composerDraftKey({ providerId: 'conversation', cwd: adopted.cwd, sessionId: adopted.id })
        setSessionDrafts(current => migrateSessionComposerDraft(current, sourceKey, targetKey))
        migrateRightSurface(sourceKey, targetKey)
        if (viewRef.current === 'chat' && sequence === sessionSelectionSeqRef.current && activeSessionIdRef.current === sourceSessionId && cwdRef.current === sourceCwd) {
          sessionSelectionSeqRef.current += 1
          selectSessionId(null)
          session.clearTurns()
          setConversationAgent(agentId)
          setConversationError(undefined)
          setLogicalConversation(adopted)
          setView('conversation')
          integrations.setSelectedId(agentId)
          requestAnimationFrame(() => taRef.current?.focus())
        }
        await loadProjects()
      } catch (error) {
        setComposerError(error instanceof Error ? error.message : String(error))
        // An IPC error may follow a committed adoption. Refresh the stable entry;
        // never repeat adoption or start a Provider automatically.
        void loadProjects()
      } finally { switchingAgentRef.current = undefined; setSwitchingAgent(false) }
    })()
  }
  const closeOverlays = (): void => {
    setSettingsTab(null)
    setShowSkills(false)
    setShowMcp(false)
    setShowLlmPerformance(false)
  }
  const openRemoteAccessSettings = (): void => {
    closeOverlays()
    setSettingsTab('remote')
  }
  const setRemoteDraft = (key: string, value: string): void => {
    setSessionDrafts((current) => updateSessionComposerDraft(current, key, (draft) => ({ ...draft, input: value }), releaseDraft))
  }
  const draftText = (key: string): string => draftStore.getSnapshot().get(key)?.input ?? ''
  const openRemoteLocation = (connectionId: string, remoteCwd: string, remoteSession?: RemoteSessionRef): void => {
    if (view === 'remote' && remoteWorkspaceDirty && !window.confirm('当前远程文件有未保存修改。放弃修改并继续吗？')) return
    setRemoteWorkspaceDirty(false)
    // Fence pending local history/new-session reads before changing execution location.
    // The local session keeps running in the background; it is not migrated.
    sessionSelectionSeqRef.current += 1
    setSessionLoading(false)
    closeOverlays()
    setRemoteTarget((current) => ({ connectionId, cwd: remoteCwd, session: remoteSession, generation: (current?.generation ?? 0) + 1 }))
    setRemoteAdoptedSession(remoteSession?.externalSessionId)
    changeView('remote')
  }
  // Switching the location of an unsent new draft carries its text along; an
  // existing session never reaches here because its location picker is locked.
  const pickRemoteLocation = (connectionId: string, remoteCwd: string): void => {
    const sourceKey = view === 'remote' && remoteTarget ? remoteDraftKey(remoteTarget.connectionId, remoteTarget.cwd) : draftKey
    const targetKey = remoteDraftKey(connectionId, remoteCwd)
    const text = draftText(sourceKey)
    if (sourceKey !== targetKey && text && !draftText(targetKey)) {
      setRemoteDraft(targetKey, text)
      if (sourceKey === draftKey) setInput('')
      else setRemoteDraft(sourceKey, '')
    }
    openRemoteLocation(connectionId, remoteCwd)
  }
  const pickLocalLocation = async (dir: string | null): Promise<void> => {
    if (view === 'remote' && remoteTarget) {
      const sourceKey = remoteDraftKey(remoteTarget.connectionId, remoteTarget.cwd)
      const targetKey = sessionComposerDraftKey({ providerId: integrations.selectedProviderId, cwd: dir, sessionId: null })
      const text = draftText(sourceKey)
      if (text && !draftText(targetKey)) {
        setRemoteDraft(targetKey, text)
        setRemoteDraft(sourceKey, '')
      }
      if (dir === cwd) {
        if (activeSessionId == null) { changeView('chat'); return }
        await newConversation()
        return
      }
    }
    if (dir == null) {
      if (cwd == null) changeView('chat')
      else await unbindProject()
      return
    }
    await pickRecent(dir)
  }
  const startNewConversation = async (): Promise<void> => {
    // A new conversation stays on the machine and project currently shown.
    if (view === 'remote' && remoteTarget) { openRemoteLocation(remoteTarget.connectionId, remoteTarget.cwd); return }
    await newConversation()
  }
  const renderLocationPicker = (current: ExecutionLocation) => (menu: { open: boolean; onOpenChange: (open: boolean) => void }) => (
    <LocationPicker
      current={current}
      localCwd={cwd}
      recent={recent}
      onPickLocal={(dir) => { void pickLocalLocation(dir) }}
      onChooseLocalFolder={chooseFolder}
      onRemoveRecent={removeRecentFolder}
      onPickRemote={pickRemoteLocation}
      onManageHosts={openRemoteAccessSettings}
      open={menu.open}
      onOpenChange={menu.onOpenChange}
    />
  )
  const metaPromptTarget = useRef<{ view: 'chat' | 'conversation' | 'remote'; draftKey: string }>({ view: 'chat', draftKey })
  // Auxiliary pages do not select a different conversation or execution machine.
  if (view === 'remote' || view === 'conversation' || view === 'chat') {
    metaPromptTarget.current = { view, draftKey: view === 'remote' ? remoteSurfaceKey : draftKey }
  }
  const openMetaPrompts = (): void => {
    if (view === 'meta-prompts' || !changeView('meta-prompts')) return
    closeOverlays()
  }
  const returnFromMetaPrompts = (): void => {
    changeView(metaPromptTarget.current.view)
    window.setTimeout(() => taRef.current?.focus(), 0)
  }
  const insertMetaPrompt = (body: string): void => {
    const target = metaPromptTarget.current
    setSessionDrafts(current => updateSessionComposerDraft(current, target.draftKey, draft => ({
      ...draft, input: appendMetaPrompt(draft.input, body)
    }), releaseDraft))
    setComposerError(null)
    setSlashHidden(true)
    returnFromMetaPrompts()
  }
  const diffOpener = useRef<HTMLElement | null>(null)
  const openDiff = useCallback((selection: DiffReviewSelection): void => {
    diffOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setTurnDiffSelection(selection)
    animatePaneChange(() => {
      surfacePane.restore()
      dispatchRightSurface({ type: 'open', kind: 'diff' })
    })
  }, [dispatchRightSurface, setTurnDiffSelection, surfacePane.restore])
  const openTurnDiffReview = useCallback((turn: { runId: string; userText: string }, _snapshot: TurnDiffSnapshot, path?: string): void => {
    openDiff({ scope: 'turn', runId: turn.runId, ...(path ? { initialPath: path } : {}) })
  }, [openDiff])
  const openWorkspaceDiff = useCallback((): void => openDiff({ scope: 'workspace' }), [openDiff])
  const diffInspector = useDiffInspector({
    cwd: view === 'conversation' ? logicalConversation?.cwd ?? null : cwd,
    summaryCwd: cwd,
    summary: integrations.gitDiff,
    summaryRefreshing: integrations.gitDiffRefreshing,
    turns: displayedTurns,
    turnOffset: view === 'chat' ? session.historyWindow?.offset : undefined,
    selection: turnDiffSelection,
    select: setTurnDiffSelection,
    enabled: panelVisible && rightSurface.activeId === 'diff',
    refreshKey: workspaceRefreshKey
  })
  const handleRightSurfaceAction = useCallback((action: RightSurfaceAction): void => {
    if (action.type === 'close' && action.kind === 'files') {
      if (!confirmWorkspaceTransition()) return
      setWorkspaceDirty(false)
    }
    const commit = (): void => {
      if (action.type === 'close' && action.kind === 'diff') {
        setTurnDiffSelection(null)
        window.requestAnimationFrame(() => {
          const target = diffOpener.current?.isConnected ? diffOpener.current : taRef.current
          target?.focus()
        })
      }
      dispatchRightSurface(action)
    }
    if (action.type === 'activate') commit()
    else animatePaneChange(commit)
  }, [confirmWorkspaceTransition, dispatchRightSurface, setWorkspaceDirty, setTurnDiffSelection])
  useEffect(() => {
    if (rightSurface.activeId !== 'diff' || !panelVisible) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') handleRightSurfaceAction({ type: 'close', kind: 'diff' })
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [handleRightSurfaceAction, panelVisible, rightSurface.activeId])
  return {
    workspaceContext,
    workspaceSendLabel: workspaceSelection.sendLabel,
    workspaceBlockedReason: workspaceSelection.blockedReason,
    openLlmPerformance,
    openSkills,
    openMcp,
    changeTheme,
    appStyle,
    mountedSurfaces,
    rightPanelMounted,
    panelVisible,
    shellPanelMounted,
    shellPanelVisible,
    shellPanelMaximized,
    pinnedSummary,
    summaryPersistent,
    summaryVisible,
    displayedTurns,
    displayedBusy,
    panelRuntimeProvider,
    activeEvidenceGap,
    showSessionOverview,
    toggleOverviewPanel,
    changeView,
    pickConversation,
    selectChatAgent,
    closeOverlays,
    openRemoteAccessSettings,
    setRemoteDraft,
    openRemoteLocation,
    pickRemoteLocation,
    pickLocalLocation,
    startNewConversation,
    renderLocationPicker,
    metaPromptTarget,
    openMetaPrompts,
    returnFromMetaPrompts,
    insertMetaPrompt,
    openTurnDiffReview,
    diffInspector,
    openWorkspaceDiff,
    handleRightSurfaceAction
  }
}
