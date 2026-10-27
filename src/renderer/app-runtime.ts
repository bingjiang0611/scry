import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ProviderId } from '@shared/provider'
import type { useAgentSession } from './hooks/useAgentSession'
import type { useIntegrations } from './hooks/useIntegrations'
import type { useWorkspaceState } from './hooks/useWorkspaceState'
import type { SessionComposerDraft, SessionPromptQueues } from './app-model'
import { focusedRunNeedsLoading, restoreFocusedRunSelection, applySessionCapturedEffects, adoptLocalStartSessionId, migrateSessionComposerDraft, migrateSessionPromptQueue, sessionComposerDraftKey } from './app-model'

export interface AppRuntimeContext {
  workspace: ReturnType<typeof useWorkspaceState>
  activeRunHydrated: boolean
  setActiveRunHydrated: Dispatch<SetStateAction<boolean>>
  sessionSelectionSeqRef: MutableRefObject<number>
  sessionNavigationSeqRef: MutableRefObject<number>
  draftStartPendingRef: MutableRefObject<boolean>
  localRunIdsRef: MutableRefObject<Set<string>>
  localStartsRef: MutableRefObject<Map<string, string>>
  localDraftOwnersRef: MutableRefObject<Map<string, { key: string; providerId: ProviderId; agentProfileId?: string; cwd: string | null }>>
  terminalRunIdsRef: MutableRefObject<Set<string>>
  requestChatBottom: (preserve?: boolean) => void
  markRunStarted: (runId: string) => void
  setComposerError: Dispatch<SetStateAction<string | null>>
  setSessionLoading: Dispatch<SetStateAction<boolean>>
  session: ReturnType<typeof useAgentSession>
  selectAgentRef: MutableRefObject<(id: string) => void>
  setSessionCacheVisible: Dispatch<SetStateAction<boolean>>
  setCwd: (cwd: string | null) => void
  selectSessionId: (id: string | null) => void
  setView: Dispatch<SetStateAction<import('./app-types').AppView>>
  activeSessionIdRef: MutableRefObject<string | null>
  cwdRef: MutableRefObject<string | null>
  draftContextRef: MutableRefObject<{ providerId: ProviderId; agentProfileId?: string; cwd: string | null }>
  migrateRightSurface: (from: string, to: string) => void
  integrations: ReturnType<typeof useIntegrations>
  setSessionDrafts: (update: (drafts: ReadonlyMap<string, SessionComposerDraft>) => ReadonlyMap<string, SessionComposerDraft>) => void
  setSessionPromptQueues: Dispatch<SetStateAction<SessionPromptQueues>>
  loadProjects: () => void | Promise<void>
  setRunningRunIds: Dispatch<SetStateAction<ReadonlySet<string>>>
  setWaitingQuestionRunIds: Dispatch<SetStateAction<ReadonlySet<string>>>
  /** 崩溃重载后回到用户离开时的会话；由 session actions 注入，仍走 canonical pickSession 读取。 */
  restoreStoredSelection: MutableRefObject<(() => Promise<void>) | null>
  setComposerErrorText?: (message: string) => void
}

export function useAppRuntimeEffects(context: AppRuntimeContext): void {
  const { workspace, activeRunHydrated, setActiveRunHydrated, sessionSelectionSeqRef, sessionNavigationSeqRef, draftStartPendingRef, localRunIdsRef,
    localStartsRef, localDraftOwnersRef, terminalRunIdsRef, requestChatBottom, markRunStarted, setComposerError,
    setSessionLoading, session, selectAgentRef, setSessionCacheVisible, setCwd, selectSessionId, setView, activeSessionIdRef,
    draftContextRef, cwdRef, migrateRightSurface, integrations, setSessionDrafts, setSessionPromptQueues, loadProjects,
    setRunningRunIds, setWaitingQuestionRunIds, restoreStoredSelection } = context

  useEffect(() => {
    let cancelled = false
    const initialSelectionSeq = sessionSelectionSeqRef.current
    const initialNavigationSeq = sessionNavigationSeqRef.current
    const canRestoreInitialSelection = (): boolean =>
      !cancelled && initialSelectionSeq === sessionSelectionSeqRef.current && initialNavigationSeq === sessionNavigationSeqRef.current
    const offFocusedRun =
      typeof window.scry.onFocusedRun === 'function'
        ? window.scry.onFocusedRun((run) => {
          const seq = ++sessionSelectionSeqRef.current
          const isCurrent = (): boolean => !cancelled && seq === sessionSelectionSeqRef.current
          const showLoading = focusedRunNeedsLoading(
            run.runId,
            draftStartPendingRef.current,
            localRunIdsRef.current
          )
          requestChatBottom(true)
          markRunStarted(run.runId)
          setComposerError(null)
          setSessionLoading(showLoading)
          void restoreFocusedRunSelection(run, {
            prepareRunFocus: session.prepareRunFocus,
            selectContext: ({ providerId, agentProfileId, cwd: nextCwd, sessionId }) => {
              setSessionCacheVisible(false)
              selectAgentRef.current(agentProfileId ?? providerId)
              setCwd(nextCwd)
              selectSessionId(sessionId)
              setView('chat')
            },
            loadSession: (context) => window.scry.loadSession(context),
            replaceWithParsedSession: session.replaceWithParsedSession,
            isCurrent
          }).catch((error) => {
            if (isCurrent()) setComposerError(`无法打开对话：${error instanceof Error ? error.message : String(error)}`)
          }).finally(() => {
            if (showLoading && isCurrent()) setSessionLoading(false)
          })
        })
        : () => { }
    const offSession =
      typeof window.scry.onSession === 'function'
        ? window.scry.onSession((event) => {
          markRunStarted(event.runId)
          const previousSessionId = activeSessionIdRef.current
          const adopted = adoptLocalStartSessionId(event, previousSessionId, localStartsRef.current)
          const draftOwner = localDraftOwnersRef.current.get(event.runId)
          const capturedSessionId = event.sessionId && (draftOwner || (previousSessionId &&
            [event.sessionId, event.runId, event.previousSessionId].includes(previousSessionId)))
            ? event.sessionId
            : adopted
          if (capturedSessionId) {
            const context = draftOwner ?? draftContextRef.current
            const previousKey = draftOwner?.key ?? sessionComposerDraftKey({ ...context, sessionId: previousSessionId })
            const capturedKey = sessionComposerDraftKey({ ...context, sessionId: capturedSessionId })
            migrateRightSurface(previousKey, capturedKey)
            integrations.migrateSessionModel(previousKey, capturedKey)
            setSessionDrafts((current) => migrateSessionComposerDraft(current, previousKey, capturedKey))
            setSessionPromptQueues((current) => migrateSessionPromptQueue(current, previousKey, capturedKey, { runId: event.runId, externalSessionId: capturedSessionId }))
            if (draftOwner) localDraftOwnersRef.current.set(event.runId, { ...draftOwner, key: capturedKey })
          }
          if (adopted) selectSessionId(adopted)
          applySessionCapturedEffects(event, {
            activeSessionId: adopted ?? activeSessionIdRef.current,
            setActiveSessionId: selectSessionId,
            loadProjects
          })
        })
        : () => { }
    // A device-initiated (remote) run recorded a session in the catalog. Refresh
    // the project/session list so the phone's conversation appears on the Mac
    // live. This is a refresh hint only - it does NOT mark a run started or
    // adopt a session, so it never disturbs the local active-run UI state.
    const offRemoteSession =
      typeof window.scry.onRemoteSessionRecorded === 'function'
        ? window.scry.onRemoteSessionRecorded(() => { loadProjects() })
        : () => { }
    const questionAttentionOverrides = new Map<string, boolean>()
    const offQuestionAttention =
      typeof window.scry.onQuestionAttention === 'function'
        ? window.scry.onQuestionAttention(({ runId, pendingCount }) => {
          const waiting = pendingCount > 0
          questionAttentionOverrides.set(runId, waiting)
          setWaitingQuestionRunIds((prev) => {
            if (prev.has(runId) === waiting) return prev
            const next = new Set(prev)
            if (waiting) next.add(runId)
            else next.delete(runId)
            return next
          })
        })
        : () => { }
    window.scry
      .activeRuns()
      .then((runs) => {
        setRunningRunIds((prev) => {
          const next = new Set(prev)
          for (const run of runs) {
            if (!run.done && !terminalRunIdsRef.current.has(run.runId)) next.add(run.runId)
          }
          return next
        })
        const waitingRuns = new Set(
          runs.filter((run) => !run.done && (run.pendingQuestions?.length ?? 0) > 0).map((run) => run.runId)
        )
        for (const [runId, waiting] of questionAttentionOverrides) {
          if (waiting) waitingRuns.add(runId)
          else waitingRuns.delete(runId)
        }
        setWaitingQuestionRunIds(waitingRuns)
      })
      .catch((error) => {
        if (!cancelled) setComposerError(`无法恢复运行列表：${error instanceof Error ? error.message : String(error)}`)
      })
    // 崩溃后主进程会静默重载 renderer：新的 React 树不知道上一棵树停在哪里，所以既恢复选中会话，
    // 也把重启事实告知用户。两者都在首屏恢复链里完成，避开“看起来一切如常”的错误暗示。
    const reportRendererRestart = async (): Promise<void> => {
      const restart = await window.scry.rendererRestart?.()
      if (!restart || cancelled) return
      // 不覆盖已经存在的错误：重启本身不能遮住真正失败的恢复。
      setComposerError((current) => current ?? `界面进程刚刚意外重启（原因：${restart.reason}，退出码 ${restart.exitCode}）。界面状态是重新建立的，重启前正在运行的一轮需要你确认实际结果。`)
    }
    window.scry
      .activeRun()
      .then(async (run) => {
        if (!canRestoreInitialSelection()) return
        if (!run || run.done) {
          // 没有仍在跑的轮次可接管时，才用上一棵树记录的选中会话兜底。
          await restoreStoredSelection.current?.()
          return
        }
        selectSessionId(run.externalSessionId ?? run.sessionId ?? run.runId)
        loadProjects()
        if (run.providerId) selectAgentRef.current(run.agentProfileId ?? run.providerId)
        if (run.cwd && run.cwd !== cwdRef.current) {
          setCwd(run.cwd)
          void window.scry.setCwd(run.cwd)
        }
      })
      .catch((error) => {
        if (canRestoreInitialSelection()) setComposerError(`无法恢复上次的运行或会话：${error instanceof Error ? error.message : String(error)}`)
      })
      .then(reportRendererRestart)
      .finally(() => {
        if (!cancelled) setActiveRunHydrated(true)
      })
    return () => {
      cancelled = true
      offFocusedRun()
      offSession()
      offRemoteSession()
      offQuestionAttention()
    }
  }, [
    loadProjects,
    markRunStarted,
    selectSessionId,
    session.prepareRunFocus,
    session.replaceWithParsedSession,
    setCwd
  ])

  useEffect(() => {
    // Provider discovery is background work. Showing the restored workspace and active run must not wait
    // for PATH/version probes, which can be slow on a cold shell.
    if (workspace.hydrated && activeRunHydrated) window.scry.rendererReady?.()
  }, [activeRunHydrated, workspace.hydrated])
}
