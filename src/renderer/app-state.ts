import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { SessionAttentionSnapshot } from '@shared/session-attention'
import type { ProviderId } from '@shared/provider'
import type { ConversationProjection } from './components/ConversationView'
import type { ConversationSummary } from '@shared/conversation-api'
import type { WorkspaceOpenRequest } from './components/WorkspacePanel'
import type { AppView } from './app-types'
import { selectedExternalSessionId } from './session-selection'
import { SessionHistorySnapshotCache } from './session-history-cache'
import { useSessionRightSurfaces } from './hooks/useSessionRightSurfaces'
import { useWorkspaceState } from './hooks/useWorkspaceState'
import { useIntegrations } from './hooks/useIntegrations'
import { createComposerDraftStore, composerDraftKey, readComposerDrafts } from './composer-drafts'
import { addRunningRunId, updateSessionComposerDraft, updateSessionPromptQueue, sessionComposerDraftKey, shouldReloadProjectsForDataUpdate, MAX_SESSION_COMPOSER_DRAFTS, type DraftAttachment, type QueuedPrompt, type SessionComposerDraft, type SessionEvidenceGap, type SessionPromptQueues } from './app-model'
import { providerCompatibilityNotice, runControlSendBlockedReason } from './hooks/useIntegrations'
import { useBackgroundWork } from './hooks/useBackgroundWork'
import { browserThemeStorage, readStoredTheme, type AppTheme } from './theme'

const EMPTY_DRAFT_ATTACHMENTS: DraftAttachment[] = []

export function useAppState() {
  const [theme, setTheme] = useState<AppTheme>(() => readStoredTheme(browserThemeStorage()))
  const [composerError, setComposerError] = useState<string | null>(null)
  const [composerSubmitting, setComposerSubmitting] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionCacheVisible, setSessionCacheVisible] = useState(false)
  const [sessionSnapshots] = useState(() => new SessionHistorySnapshotCache())
  useEffect(() => () => sessionSnapshots.clear(), [sessionSnapshots])
  // 选中的历史会话读不到证据时保留原因；新会话、切会话与新轮次都会清空它。
  const [sessionEvidenceGap, setSessionEvidenceGap] = useState<SessionEvidenceGap | null>(null)
  const draftStartPendingRef = useRef(false)
  const [activeRunHydrated, setActiveRunHydrated] = useState(false)
  const workspace = useWorkspaceState()
  const {
    cwd,
    setCwd,
    recent,
    projects,
    activeSessionId,
    setActiveSessionId,
    loadProjects,
    chooseFolder,
    removeRecentFolder,
    catalogHealth
  } = workspace
  const workspaceRoots = useMemo(
    () => [...new Set([cwd, ...projects.map((project) => project.cwd)].filter((root): root is string => !!root))],
    [cwd, projects]
  )
  useEffect(() => {
    const setWindowTheme = window.scry.setTheme
    if (typeof setWindowTheme === 'function') void setWindowTheme(theme).catch(() => { })
  }, [theme])
  const backgroundWorkByRun = useBackgroundWork()
  const [runningRunIds, setRunningRunIds] = useState<ReadonlySet<string>>(() => new Set())
  const [waitingQuestionRunIds, setWaitingQuestionRunIds] = useState<ReadonlySet<string>>(() => new Set())
  const [unreadSessionKeys, setUnreadSessionKeys] = useState<ReadonlySet<string>>(() => new Set())
  const unreadRevisionRef = useRef(-1)
  const terminalRunIdsRef = useRef(new Set<string>())
  const localRunIdsRef = useRef(new Set<string>())
  // runId -> 发送时的会话身份：用于采纳本视图发起那一轮新建的原生 session id。
  const localStartsRef = useRef(new Map<string, string>())
  // Keep draft ownership independent from the currently visible conversation. A
  // Provider may reveal its native session id after the user has already switched
  // away; the draft must still move from the provisional run key in that case.
  const localDraftOwnersRef = useRef(new Map<string, {
    key: string
    providerId: ProviderId
    agentProfileId?: string
    cwd: string | null
  }>())
  useEffect(() => {
    const applySnapshot = (snapshot: SessionAttentionSnapshot): void => {
      if (snapshot.revision < unreadRevisionRef.current) return
      unreadRevisionRef.current = snapshot.revision
      setUnreadSessionKeys(new Set(snapshot.unreadSessionKeys))
    }
    const unsubscribe = window.scry.onUnreadSessions?.(applySnapshot)
    void window.scry.unreadSessions?.().then(applySnapshot).catch(() => { })
    return unsubscribe
  }, [])
  const markRunStarted = useCallback((runId: string): void => {
    // Session capture/focus callbacks may arrive after terminal delivery. Run IDs
    // are never reused: a late announcement must not erase terminal evidence.
    setRunningRunIds((prev) => addRunningRunId(prev, runId, terminalRunIdsRef.current))
  }, [])
  const markRunFinished = useCallback((runId: string): void => {
    localRunIdsRef.current.delete(runId)
    localStartsRef.current.delete(runId)
    localDraftOwnersRef.current.delete(runId)
    terminalRunIdsRef.current.add(runId)
    while (terminalRunIdsRef.current.size > 512) {
      const oldest = terminalRunIdsRef.current.values().next().value
      if (oldest === undefined) break
      terminalRunIdsRef.current.delete(oldest)
    }
    setRunningRunIds((prev) => {
      if (!prev.has(runId)) return prev
      const next = new Set(prev)
      next.delete(runId)
      return next
    })
    setWaitingQuestionRunIds((prev) => {
      if (!prev.has(runId)) return prev
      const next = new Set(prev)
      next.delete(runId)
      return next
    })
  }, [])
  const cwdRef = useRef(cwd)
  const activeSessionIdRef = useRef(activeSessionId)
  cwdRef.current = cwd
  activeSessionIdRef.current = activeSessionId
  const selectSessionId = useCallback(
    (sessionId: string | null): void => {
      activeSessionIdRef.current = sessionId
      setActiveSessionId(sessionId)
    },
    [setActiveSessionId]
  )
  const [showSkills, setShowSkills] = useState(false)
  const [showMcp, setShowMcp] = useState(false)
  const [showLlmPerformance, setShowLlmPerformance] = useState(false)
  const [view, setView] = useState<AppView>('chat')
  const [logicalConversation, setLogicalConversation] = useState<ConversationSummary>()
  const [conversationError, setConversationError] = useState<string>()
  const [conversationAgent, setConversationAgent] = useState<string>()
  const [conversationProjection, setConversationProjection] = useState<ConversationProjection>()
  const [switchingAgent, setSwitchingAgent] = useState(false)
  const switchingAgentRef = useRef<string>()
  const viewRef = useRef(view)
  viewRef.current = view
  const integrations = useIntegrations(cwd, activeSessionId, projects, showMcp ? 'mcp' : showSkills ? 'skills' : null)
  useEffect(() => {
    const subscribe = window.scry.onDataUpdated
    if (typeof subscribe !== 'function') return
    return subscribe((event) => {
      // This event carries no session identity. Clear all eight bounded entries,
      // and fence pending reads so deletion/recording cannot restore an old cache.
      sessionSnapshots.clear()
      setSessionCacheVisible(false)
      if (shouldReloadProjectsForDataUpdate(event)) loadProjects()
    })
  }, [loadProjects, sessionSnapshots])
  const selectedProviderSessionId = useMemo(() => selectedExternalSessionId(projects, {
    cwd,
    sessionId: activeSessionId,
    providerId: integrations.selectedProviderId,
    agentProfileId: integrations.providerContext.agentProfileId
  }), [
    activeSessionId,
    cwd,
    integrations.providerContext.agentProfileId,
    integrations.selectedProviderId,
    projects
  ])
  const [draftStore] = useState(() => {
    try {
      return createComposerDraftStore(new Map([...readComposerDrafts(window.localStorage).entries()].slice(-MAX_SESSION_COMPOSER_DRAFTS)))
    } catch {
      return createComposerDraftStore(new Map())
    }
  })
  const setSessionDrafts = draftStore.update
  const draftKey = useMemo(() => view === 'chat' && switchingAgent && switchingAgentRef.current
    ? switchingAgentRef.current
    : view === 'conversation' && logicalConversation
      ? composerDraftKey({ providerId: 'conversation', cwd: logicalConversation.cwd, sessionId: logicalConversation.id })
      : sessionComposerDraftKey({
        providerId: integrations.selectedProviderId,
        agentProfileId: integrations.providerContext.agentProfileId,
        cwd,
        sessionId: selectedProviderSessionId ?? activeSessionId
      }), [
    activeSessionId,
    cwd,
    integrations.providerContext.agentProfileId,
    integrations.selectedProviderId,
    selectedProviderSessionId,
    view,
    switchingAgent,
    logicalConversation?.id,
    logicalConversation?.cwd
  ])
  const rightSurfaces = useSessionRightSurfaces(draftKey, cwd)
  const { current: currentSurface, dispatch: dispatchRightSurface, migrate: migrateRightSurface } = rightSurfaces
  const rightSurface = currentSurface.state
  const hasSurfaceContext = Boolean(cwd || activeSessionId)
  const terminalOpen = rightSurface.openIds.includes('terminal')
  const [workspaceDirtyScopes, setWorkspaceDirtyScopes] = useState<Record<string, boolean>>({})
  const workspaceDirty = workspaceDirtyScopes[currentSurface.id] ?? false
  const setScopeDirty = useCallback((id: string, dirty: boolean): void => {
    setWorkspaceDirtyScopes((previous) => previous[id] === dirty ? previous : { ...previous, [id]: dirty })
  }, [])
  const setWorkspaceDirty = useCallback((dirty: boolean): void => setScopeDirty(currentSurface.id, dirty), [currentSurface.id, setScopeDirty])
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0)
  const [workspaceOpenRequests, setWorkspaceOpenRequests] = useState<ReadonlyMap<string, WorkspaceOpenRequest>>(() => new Map())
  const workspaceOpenSequenceRef = useRef(0)
  const confirmWorkspaceTransition = useCallback(
    (): boolean => !workspaceDirty || window.confirm('当前文件有未保存修改。放弃修改并继续吗？'),
    [workspaceDirty]
  )
  const draftContextRef = useRef({
    providerId: integrations.selectedProviderId,
    agentProfileId: integrations.providerContext.agentProfileId,
    cwd
  })
  draftContextRef.current = {
    providerId: integrations.selectedProviderId,
    agentProfileId: integrations.providerContext.agentProfileId,
    cwd
  }
  const readDraftAttachments = () => {
    const attachments = draftStore.getSnapshot().get(draftKey)?.attachments
    return attachments?.length ? attachments : EMPTY_DRAFT_ATTACHMENTS
  }
  const draftAttachments = useSyncExternalStore(draftStore.subscribe, readDraftAttachments, readDraftAttachments)
  const [sessionPromptQueues, setSessionPromptQueues] = useState<SessionPromptQueues>(() => new Map())
  const queuedPrompts = sessionPromptQueues.get(draftKey) ?? []
  const setQueuedPrompts: Dispatch<SetStateAction<QueuedPrompt[]>> = useCallback((update) => {
    setSessionPromptQueues((current) => updateSessionPromptQueue(current, draftKey, (currentQueue) =>
      typeof update === 'function' ? update(currentQueue) : update
    ))
  }, [draftKey])
  // 正在输入框里改写的队列条目；编辑期间它不参与自动出队。
  const [editingQueuedPromptId, setEditingQueuedPromptId] = useState<string | null>(null)
  // 编辑后重新排队的那条，短暂标出「已移到队尾」，让位置变化可验证而不是只靠记忆。
  const [movedQueuedPromptId, setMovedQueuedPromptId] = useState<string | null>(null)
  const releaseDraft = useCallback((discarded: SessionComposerDraft): void => {
    for (const attachment of discarded.attachments) {
      if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
    }
  }, [])
  const setInput: Dispatch<SetStateAction<string>> = useCallback((update) => {
    setSessionDrafts((current) => updateSessionComposerDraft(current, draftKey, (currentDraft) => ({
      ...currentDraft,
      input: typeof update === 'function' ? update(currentDraft.input) : update
    }), releaseDraft))
  }, [draftKey, releaseDraft, setSessionDrafts])
  const setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>> = useCallback((update) => {
    setSessionDrafts((current) => updateSessionComposerDraft(current, draftKey, (currentDraft) => ({
      ...currentDraft,
      attachments: typeof update === 'function' ? update(currentDraft.attachments) : update
    }), releaseDraft))
  }, [draftKey, releaseDraft, setSessionDrafts])
  const providerSendBlockedReason = !integrations.agentsHydrated
    ? '正在检测本机 Provider，暂不能发送'
    : !integrations.selectedAgent
      ? `未检测到 ${integrations.selectedId}，草稿与附件已保留`
      : integrations.selectedAgent.health?.state === 'unavailable'
        ? integrations.selectedAgent.health.lastError ?? `${integrations.selectedAgent.name} 当前不可用`
        : runControlSendBlockedReason(
          integrations.selectedProviderId,
          integrations.runControlCapability,
          integrations.runControlsLoading,
          integrations.runControls
        )
  const sendBlockedReason = providerSendBlockedReason
  // 版本兼容性是提示而不是阻断：只有在没有真正阻断原因时才占用状态行。
  const providerCompatibilityIssue = providerCompatibilityNotice(integrations.selectedAgent)
  return {
    theme,
    setTheme,
    composerError,
    setComposerError,
    composerSubmitting,
    setComposerSubmitting,
    sessionLoading,
    setSessionLoading,
    sessionCacheVisible,
    setSessionCacheVisible,
    sessionSnapshots,
    sessionEvidenceGap,
    setSessionEvidenceGap,
    draftStartPendingRef,
    activeRunHydrated,
    setActiveRunHydrated,
    workspace,
    cwd,
    setCwd,
    recent,
    projects,
    activeSessionId,
    loadProjects,
    chooseFolder,
    removeRecentFolder,
    catalogHealth,
    workspaceRoots,
    backgroundWorkByRun,
    runningRunIds,
    setRunningRunIds,
    waitingQuestionRunIds,
    setWaitingQuestionRunIds,
    unreadSessionKeys,
    terminalRunIdsRef,
    localRunIdsRef,
    localStartsRef,
    localDraftOwnersRef,
    unreadRevisionRef,
    markRunStarted,
    markRunFinished,
    cwdRef,
    activeSessionIdRef,
    selectSessionId,
    showSkills,
    setShowSkills,
    showMcp,
    setShowMcp,
    showLlmPerformance,
    setShowLlmPerformance,
    view,
    setView,
    logicalConversation,
    setLogicalConversation,
    conversationError,
    setConversationError,
    conversationAgent,
    setConversationAgent,
    conversationProjection,
    setConversationProjection,
    switchingAgent,
    setSwitchingAgent,
    switchingAgentRef,
    viewRef,
    integrations,
    selectedProviderSessionId,
    draftStore,
    setSessionDrafts,
    draftKey,
    rightSurfaces,
    currentSurface,
    dispatchRightSurface,
    migrateRightSurface,
    rightSurface,
    terminalOpen,
    hasSurfaceContext,
    workspaceDirtyScopes,
    workspaceDirty,
    setScopeDirty,
    setWorkspaceDirty,
    workspaceRefreshKey,
    setWorkspaceRefreshKey,
    workspaceOpenRequests,
    setWorkspaceOpenRequests,
    workspaceOpenSequenceRef,
    confirmWorkspaceTransition,
    draftContextRef,
    draftAttachments,
    sessionPromptQueues,
    setSessionPromptQueues,
    queuedPrompts,
    setQueuedPrompts,
    editingQueuedPromptId,
    setEditingQueuedPromptId,
    movedQueuedPromptId,
    setMovedQueuedPromptId,
    releaseDraft,
    setInput,
    setDraftAttachments,
    providerSendBlockedReason,
    sendBlockedReason,
    providerCompatibilityIssue,
    readDraftAttachments
  }
}
