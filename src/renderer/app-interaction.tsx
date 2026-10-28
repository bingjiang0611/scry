import { useCallback, useRef, useState } from 'react'
import { AppShell } from './app-shell'
import { useAppComposer } from './app-composer'
import { useAppRuntimeEffects } from './app-runtime'
import { useAppView } from './app-view'
import { useAppQueueActions } from './app-queue-actions'
import { createAppChatProps } from './app-chat-props'
import { useAppSlashCommands } from './hooks/useAppSlashCommands'
import { createSessionActions } from './app-session-actions'
import { useChatNavigation } from './hooks/useChatNavigation'
import { useRemoteWorkbench } from './hooks/useRemoteWorkbench'
import type { SessionRef } from './env'
import type { SettingsTab } from './components/Modals'
import { useResizablePane } from './hooks/useResizablePane'
import { applyProviderCatalogRefresh, resetQueuedPromptControl, updateSessionPromptQueue, type DraftAttachment } from './app-model'
import { scrollChatToBottomIfNeeded } from './chat-scroll'
import { retainProtectedSteerPrompts } from './steer'
import { useAppSidebarActions } from './app-sidebar-actions'
import { useAppSessionRuntime } from './app-session-runtime'
import { useAppDraftPersistence } from './app-draft-persistence'
import { useDiffReviewSelection } from './hooks/useDiffReviewSelection'
import { useConversationWorkspace } from './hooks/useConversationWorkspace'
const SIDEBAR_MIN = 190
const SIDEBAR_MAX = 260
const PANEL_MIN = 360
const PANEL_MAX = 960
const EMPTY_DRAFT_ATTACHMENTS: DraftAttachment[] = []
type AppInteractionContext = { state: ReturnType<typeof import('./app-state').useAppState> }
export function useAppInteraction(context: AppInteractionContext) {
  const { state } = context
  const { theme, setTheme, composerError, setComposerError, composerSubmitting, setComposerSubmitting, sessionLoading, setSessionLoading,
    sessionCacheVisible, setSessionCacheVisible, sessionSnapshots, sessionEvidenceGap, setSessionEvidenceGap, draftStartPendingRef,
    activeRunHydrated, setActiveRunHydrated, workspace, cwd, setCwd, recent, projects, activeSessionId, loadProjects, chooseFolder,
    removeRecentFolder, workspaceRoots, setRunningRunIds, setWaitingQuestionRunIds, terminalRunIdsRef, localRunIdsRef, localStartsRef, localDraftOwnersRef, markRunStarted,
    markRunFinished, cwdRef, activeSessionIdRef, selectSessionId, showSkills, setShowSkills, showMcp, setShowMcp, showLlmPerformance,
    setShowLlmPerformance, view, setView, logicalConversation, setLogicalConversation, setConversationError, setConversationAgent,
    conversationProjection, setConversationProjection, switchingAgent, setSwitchingAgent,
    switchingAgentRef, viewRef, integrations, selectedProviderSessionId, draftStore, setSessionDrafts, draftKey, rightSurfaces,
    currentSurface, dispatchRightSurface, migrateRightSurface, rightSurface, terminalOpen, hasSurfaceContext, setScopeDirty, setWorkspaceDirty, workspaceRefreshKey, setWorkspaceRefreshKey, workspaceOpenRequests,
    setWorkspaceOpenRequests, workspaceOpenSequenceRef, confirmWorkspaceTransition, draftContextRef, draftAttachments,
    sessionPromptQueues, setSessionPromptQueues, queuedPrompts, setQueuedPrompts, editingQueuedPromptId, setEditingQueuedPromptId,
    movedQueuedPromptId, setMovedQueuedPromptId, releaseDraft, setInput, setDraftAttachments, providerSendBlockedReason,
    sendBlockedReason, providerCompatibilityIssue } = state
  const sessionRuntime = useAppSessionRuntime({
    activeSessionIdRef, localDraftOwnersRef, integrations, setSessionDrafts, setSessionPromptQueues, migrateRightSurface,
    markRunFinished, setWorkspaceRefreshKey, selectSessionId, loadProjects, sessionLoading, activeSessionId, draftKey
  })
  const { session, steerEvidenceByMessageId, steerCapability } = sessionRuntime

  const sidebarPane = useResizablePane({
    // The evidence-system shell deliberately resets the old 256px default once;
    // subsequent user resizing is still persisted under this geometry version.
    id: 'sidebar-evidence-system',
    defaultWidth: 230,
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    side: 'left'
  })
  const surfacePane = useResizablePane({
    id: 'right-surface-panel',
    defaultWidth: 520,
    min: PANEL_MIN,
    max: PANEL_MAX,
    side: 'right'
  })
  const [turnDiffSelection, setTurnDiffSelection] = useDiffReviewSelection(currentSurface.id)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const [archiveUndo, setArchiveUndo] = useState<{ ref: SessionRef; preview: string } | null>(null)
  useConversationWorkspace(view, logicalConversation, cwd, setConversationError, setComposerError)
  const {
    remoteTarget, setRemoteTarget, remoteQueueStore, remoteAdoptedSession, setRemoteAdoptedSession,
    remoteSurfaces, remoteSurface, remoteSurfaceKey, remoteWorkspaceDirty, setRemoteWorkspaceDirty,
    remoteSurfaceTarget, setRemoteSurfaceTarget, remotePanelVisible, dispatchRemoteSurface, desktopConnections
  } = useRemoteWorkbench({ view, surfacePane })
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatNavigation = useChatNavigation(scrollRef, view === 'chat' || view === 'conversation', session.turns.length,
    view === 'conversation' ? logicalConversation?.id : selectedProviderSessionId)
  const { focusedTurnRunId } = chatNavigation
  const shouldStickToBottomRef = useRef(true)
  const openingSessionBottomRef = useRef(false)
  const requestChatBottom = useCallback((preserveDuringSessionOpen = false): void => {
    chatNavigation.cancel()
    if (preserveDuringSessionOpen) openingSessionBottomRef.current = true
    shouldStickToBottomRef.current = true
    scrollChatToBottomIfNeeded(scrollRef.current, true)
  }, [chatNavigation.cancel])
  const queuedStartPendingRef = useRef(false)
  const queuedStartInFlightRef = useRef(false)
  const queuedDrainGenerationRef = useRef(0)
  const queueKeyRef = useRef(draftKey)
  queueKeyRef.current = draftKey
  const pausedQueuedPromptsRef = useRef(new Set<string>())
  // React state is intentionally not the double-click guard: two clicks can happen before
  // the pending row repaint. This ref is the synchronous admission barrier.
  const steerInFlightRef = useRef(new Set<string>())
  const resetPromptQueueControl = useCallback((): void => {
    // 切换上下文只重置当前启动控制；队列本身按会话保存，不能被跨会话切换误删。
    const reset = resetQueuedPromptControl(queuedDrainGenerationRef.current)
    queuedDrainGenerationRef.current = reset.generation
    queuedStartPendingRef.current = reset.pending
    queuedStartInFlightRef.current = reset.inFlight
  }, [])
  const clearSessionPromptQueue = useCallback((key = queueKeyRef.current): void => {
    if (key === queueKeyRef.current) resetPromptQueueControl()
    setSessionPromptQueues((current) => updateSessionPromptQueue(current, key, (queue) => {
      const retained = retainProtectedSteerPrompts(queue, steerEvidenceByMessageId, steerInFlightRef.current)
      const retainedIds = new Set(retained.map(prompt => prompt.messageId))
      for (const prompt of queue) {
        // An explicit stop must not discard uncertain inputs, or start them as an ordinary
        // turn if their outstanding admission later returns a definite rejection.
        if (retainedIds.has(prompt.messageId)) pausedQueuedPromptsRef.current.add(prompt.messageId)
        else pausedQueuedPromptsRef.current.delete(prompt.messageId)
      }
      return retained
    }))
  }, [resetPromptQueueControl, steerEvidenceByMessageId])
  const sessionSelectionSeqRef = useRef(0)
  // Provider selection changes this callback's identity. Runtime subscriptions/bootstrap must
  // not restart with it, or the previous focused run can overwrite an in-flight session choice.
  const selectAgentRef = useRef(integrations.setSelectedId)
  selectAgentRef.current = integrations.setSelectedId
  const taRef = useRef<HTMLTextAreaElement>(null)
  const {
    slashCmds, slashReason, slashLoading, slashSel, setSlashSel,
    slashHidden, setSlashHidden, slashToken, slashOpen, retrySlash, refreshSlashCatalog
  } = useAppSlashCommands(integrations.providerContext, draftStore, draftKey)
  const refreshProviderCatalogs = (): Promise<void> => applyProviderCatalogRefresh({
    invalidateProviderContext: typeof window.scry.invalidateProviderContext === 'function'
      ? () => window.scry.invalidateProviderContext(integrations.providerContext)
      : undefined,
    refreshSkills: showSkills ? integrations.refreshSkills : undefined,
    retrySlash
  })

  const clearDraftAttachments = useAppDraftPersistence({ draftStore, setComposerError, archiveUndo, setArchiveUndo, setDraftAttachments })


  // 崩溃重载后的会话恢复必须复用 canonical pickSession（它会重读会话与运行证据），而它由下面的
  // session actions 提供；effect 在渲染后执行，此处 ref 已赋值。
  const restoreStoredSelectionRef = useRef<(() => Promise<void>) | null>(null)
  const sessionNavigationSeqRef = useRef(0)
  useAppRuntimeEffects({
    workspace, activeRunHydrated, setActiveRunHydrated, sessionSelectionSeqRef, sessionNavigationSeqRef, draftStartPendingRef, localRunIdsRef,
    localStartsRef, localDraftOwnersRef, terminalRunIdsRef, requestChatBottom, markRunStarted, setComposerError,
    setSessionLoading, session, selectAgentRef, setSessionCacheVisible, setCwd, selectSessionId, setView,
    activeSessionIdRef, cwdRef, draftContextRef, migrateRightSurface, integrations, setSessionDrafts, setSessionPromptQueues,
    loadProjects, setRunningRunIds, setWaitingQuestionRunIds, restoreStoredSelection: restoreStoredSelectionRef
  })

  const composer = useAppComposer({
    openWorkspaceRun: (target, sessionId, runId) => openWorkspaceRun(target, sessionId, runId),
    view, cwd, setCwd, loadProjects, sessionSelectionSeqRef, viewRef, setView, switchingAgentRef, movedQueuedPromptId, EMPTY_DRAFT_ATTACHMENTS,
    draftStore, draftKey, session, integrations, chatNavigation, scrollRef, taRef,
    selectedProviderSessionId, sessionLoading, sendBlockedReason, setComposerError, setComposerSubmitting,
    setInput, setDraftAttachments, clearDraftAttachments, setSlashHidden, setSlashSel,
    slash: { slashCmds, slashReason, slashLoading, slashSel, setSlashSel, slashHidden, setSlashHidden, slashToken, slashOpen, retrySlash, refreshSlashCatalog },
    draftStartPendingRef, activeSessionIdRef, cwdRef, draftContextRef, localDraftOwnersRef, localRunIdsRef, localStartsRef,
    selectSessionId, migrateRightSurface, shouldStickToBottomRef, openingSessionBottomRef, queuedStartPendingRef,
    queuedStartInFlightRef, queuedDrainGenerationRef, queueKeyRef, pausedQueuedPromptsRef, steerInFlightRef, queuedPrompts,
    setQueuedPrompts, setSessionPromptQueues, sessionPromptQueues, editingQueuedPromptId, setEditingQueuedPromptId,
    setMovedQueuedPromptId, steerEvidenceByMessageId
  })
  const { pickSlash, addPastedImages, addClipboardImage, send, openTurnInChat } = composer
  // 选一个工作目录 = 只重新绑定，停在新会话空态。
  // 曾经的行为是该目录有历史会话就直接打开最近那条（pickSession(sessions[0])），
  // 结果“换项目”变成“被扔进一个旧对话”，绑定后的工作目录也没机会看清。
  const {
    pickRecent, unbindProject, newConversation, newConversationInProject,
    toggleProjectPin, renameProject, removeProject, pickSession, openWorkspaceRun, forkConversationTurn,
    togglePinSession, renameSession, archiveSession, undoArchive, restoreLastSelection
  } = createSessionActions({
    workspace, session, integrations, setSessionLoading, sessionSelectionSeqRef, sessionNavigationSeqRef,
    resetPromptQueueControl, shouldStickToBottomRef, selectSessionId, setView, taRef,
    draftContextRef, setSessionEvidenceGap, setSessionPromptQueues, setComposerError,
    confirmWorkspaceTransition, cwdRef, activeSessionIdRef, sessionLoading, sessionSnapshots,
    setSessionCacheVisible, requestChatBottom, selectedProviderSessionId, clearSessionPromptQueue,
    queueKeyRef, setArchiveUndo, archiveUndo, refreshProviderCatalogs
  })
  restoreStoredSelectionRef.current = restoreLastSelection
  const appView = useAppView({
    openWorkspaceRun, sessionNavigationSeqRef,
    theme, setTheme, setShowSkills, setShowMcp, setShowLlmPerformance, refreshProviderCatalogs,
    view, setView, cwd, setCwd, activeSessionId, selectSessionId, session, integrations, sessionLoading, composerSubmitting,
    switchingAgentRef, setSwitchingAgent, setComposerError, draftAttachments, queuedPrompts, draftKey, draftStore, setInput,
    releaseDraft, selectedProviderSessionId, sessionSelectionSeqRef, activeSessionIdRef, cwdRef, setSessionDrafts, migrateRightSurface,
    loadProjects, projects, recent, chooseFolder, removeRecentFolder, confirmWorkspaceTransition, logicalConversation, setConversationError, setConversationAgent, setLogicalConversation,
    remoteWorkspaceDirty, setRemoteWorkspaceDirty, remoteTarget, setRemoteTarget, setRemoteAdoptedSession,
    remoteSurfaces, remoteSurfaceKey, remotePanelVisible, remoteSurface, rightSurface, hasSurfaceContext, terminalOpen, surfacePane,
    sidebarPane, rightSurfaces, currentSurface, dispatchRightSurface, setTurnDiffSelection, setWorkspaceDirty, turnDiffSelection, taRef, setSlashHidden,
    viewRef, conversationProjection, sessionEvidenceGap, workspaceRefreshKey,
    setSettingsTab, newConversation, unbindProject, pickRecent, setSessionLoading
  })
  const { openLlmPerformance, openSkills, openMcp, changeView, pickConversation,
    selectChatAgent, openRemoteLocation, startNewConversation, renderLocationPicker, openMetaPrompts, openTurnDiffReview,
    pinnedSummary, activeEvidenceGap } = appView
  const queueActions = useAppQueueActions({
    session, integrations, cwd, selectedProviderSessionId, activeSessionIdRef, sessionPromptQueues, setSessionPromptQueues,
    steerEvidenceByMessageId, steerInFlightRef, queuedStartInFlightRef, queuedStartPendingRef, pausedQueuedPromptsRef, queuedPrompts,
    setComposerError, setInput, setSlashHidden, setDraftAttachments, setEditingQueuedPromptId, setMovedQueuedPromptId,
    EMPTY_DRAFT_ATTACHMENTS, draftStore, draftKey, taRef, clearSessionPromptQueue, setWorkspaceOpenRequests, workspaceOpenSequenceRef,
    currentSurface, surfacePane, dispatchRightSurface
  })
  const { steerQueuedPrompt, removeQueuedPrompt, editQueuedPrompt, cancelQueuedPromptEdit, removeDraftAttachment,
    openWorkspaceFile, addWorkspaceReference, stopRun, loadOlderTurns, historyOlderLoading } = queueActions
  const chatProps = createAppChatProps({
    workspaceContext: appView.workspaceContext, workspaceSendLabel: appView.workspaceSendLabel, workspaceBlockedReason: appView.workspaceBlockedReason,
    draftStore, draftKey, session, scrollRef, taRef, cwd, workspaceRoots, recent, integrations, switchingAgent, composerSubmitting,
    sessionLoading, activeSessionId, sendBlockedReason, composerError, providerSendBlockedReason, providerCompatibilityIssue,
    sessionCacheVisible, activeEvidenceGap, draftAttachments, queuedPrompts, steerCapability, steerEvidenceByMessageId,
    steerInFlightRef: steerInFlightRef.current, editingQueuedPromptId, movedQueuedPromptId, slashOpen, slashLoading,
    slashCmds, slashReason, slashSel, focusedTurnRunId, chatNavigation, addPastedImages, addClipboardImage, pickSlash, send,
    stopRun, loadOlderTurns, historyOlderLoading, openTurnDiffReview, forkConversationTurn, openWorkspaceFile, selectChatAgent,
    setInput, setComposerError, setSlashHidden, setSlashSel, chooseFolder, unbindProject, pickRecent, removeRecentFolder,
    renderLocationPicker, retrySlash, steerQueuedPrompt, editQueuedPrompt, cancelQueuedPromptEdit, removeDraftAttachment,
    removeQueuedPrompt, slashHidden
  })

  const sidebarActions = useAppSidebarActions({
    startNewConversation, openRemoteLocation, remoteQueueStore, view, remoteTarget, remoteAdoptedSession, pickSession,
    togglePinSession, archiveSession, renameSession, newConversationInProject, pickConversation, toggleProjectPin, renameProject,
    removeProject, undoArchive, changeView, openLlmPerformance, openSkills, openMcp, openMetaPrompts,
    setSettingsTab
  })


  const shellProps = {
    ...state,
    ...appView,
    appStyle: appView.appStyle,
    sidebarPane,
    surfacePane,
    draftStore,
    chatProps,
    sidebarActions,
    desktopConnections,
    remoteQueueStore,
    remoteSurfaceTarget,
    setRemoteSurfaceTarget,
    remoteSurface,
    remotePanelVisible,
    remoteAdoptedSession,
    remoteSurfaceKey,
    remoteSurfaces,
    remoteTarget,
    setRemoteTarget,
    setRemoteAdoptedSession,
    dispatchRemoteSurface,
    scrollRef,
    taRef,
    setConversationProjection,
    setRemoteWorkspaceDirty,
    setScopeDirty,
    setWorkspaceOpenRequests,
    workspaceOpenRequests,
    workspaceRefreshKey,
    setArchiveUndo,
    archiveUndo,
    settingsTab,
    setSettingsTab,
    theme,
    setShowLlmPerformance,
    showLlmPerformance,
    showSkills,
    showMcp,
    setShowSkills,
    setShowMcp,
    integrations,
    session,
    sidebarMin: SIDEBAR_MIN,
    sidebarMax: SIDEBAR_MAX,
    panelMin: PANEL_MIN,
    panelMax: PANEL_MAX,
    openTurnInChat,
    addWorkspaceReference,
    summary: pinnedSummary,
    changeTheme: appView.changeTheme,
    mountedSurfaces: appView.mountedSurfaces,
    rightPanelMounted: appView.rightPanelMounted,
    panelVisible: appView.panelVisible,
    shellPanelMounted: appView.shellPanelMounted,
    shellPanelVisible: appView.shellPanelVisible,
    shellPanelMaximized: appView.shellPanelMaximized,
    summaryPersistent: appView.summaryPersistent,
    summaryVisible: appView.summaryVisible,
    displayedTurns: appView.displayedTurns,
    displayedBusy: appView.displayedBusy,
    panelRuntimeProvider: appView.panelRuntimeProvider,
    activeEvidenceGap: appView.activeEvidenceGap,
    showSessionOverview: appView.showSessionOverview,
    toggleOverviewPanel: appView.toggleOverviewPanel,
    setRemoteDraft: appView.setRemoteDraft,
    metaPromptTarget: appView.metaPromptTarget,
    returnFromMetaPrompts: appView.returnFromMetaPrompts,
    insertMetaPrompt: appView.insertMetaPrompt,
    diffInspector: appView.diffInspector,
    openWorkspaceDiff: appView.openWorkspaceDiff,
    handleRightSurfaceAction: appView.handleRightSurfaceAction
  }
  return <AppShell {...shellProps} />
}