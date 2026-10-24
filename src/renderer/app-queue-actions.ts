import { useCallback, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import type { ActiveRun } from '@shared/trace'
import type { WorkspaceEntry } from '@shared/workspace'
import type { WorkspaceFileTarget } from './workspace-links'
import type { useAgentSession } from './hooks/useAgentSession'
import type { useIntegrations } from './hooks/useIntegrations'
import type { useSessionRightSurfaces } from './hooks/useSessionRightSurfaces'
import type { WorkspaceOpenRequest } from './components/WorkspacePanel'
import type { DraftAttachment, QueuedPrompt, SessionPromptQueues } from './app-model'
import { appendWorkspaceReference } from './app-model'
import { QUEUE_COPY } from './constants/copy'
import { activeSteerIdentityMatches, isSteerRemovalBlocked, latestSteerCapability, steerStateForMessage, updateQueuedPromptByMessageId } from './steer'
import { workspaceReferenceToken } from './components/WorkspacePanel'

export interface AppQueueContext {
  session: ReturnType<typeof useAgentSession>
  integrations: ReturnType<typeof useIntegrations>
  cwd: string | null
  selectedProviderSessionId: string | null
  activeSessionIdRef: MutableRefObject<string | null>
  sessionPromptQueues: SessionPromptQueues
  setSessionPromptQueues: Dispatch<SetStateAction<SessionPromptQueues>>
  steerEvidenceByMessageId: ReadonlyMap<string, import('@shared/runtime').AgentSteerEvidence & { eventId: string }>
  steerInFlightRef: MutableRefObject<Set<string>>
  queuedStartInFlightRef: MutableRefObject<boolean>
  queuedStartPendingRef: MutableRefObject<boolean>
  pausedQueuedPromptsRef: MutableRefObject<Set<string>>
  queuedPrompts: QueuedPrompt[]
  setComposerError: Dispatch<SetStateAction<string | null>>
  setInput: Dispatch<SetStateAction<string>>
  setSlashHidden: Dispatch<SetStateAction<boolean>>
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>
  setEditingQueuedPromptId: Dispatch<SetStateAction<string | null>>
  setMovedQueuedPromptId: Dispatch<SetStateAction<string | null>>
  EMPTY_DRAFT_ATTACHMENTS: DraftAttachment[]
  draftStore: ReturnType<typeof import('./composer-drafts').createComposerDraftStore>
  draftKey: string
  taRef: RefObject<HTMLTextAreaElement>
  clearSessionPromptQueue: () => void
  setWorkspaceOpenRequests: Dispatch<SetStateAction<ReadonlyMap<string, WorkspaceOpenRequest>>>
  workspaceOpenSequenceRef: MutableRefObject<number>
  currentSurface: ReturnType<typeof useSessionRightSurfaces>['current']
  surfacePane: ReturnType<typeof import('./hooks/useResizablePane').useResizablePane>
  dispatchRightSurface: (action: import('./right-surface').RightSurfaceAction) => void
}

export function useAppQueueActions(context: AppQueueContext) {
  const { session, integrations, cwd, selectedProviderSessionId, activeSessionIdRef, sessionPromptQueues, setSessionPromptQueues,
    steerEvidenceByMessageId, steerInFlightRef, queuedStartInFlightRef, queuedStartPendingRef, pausedQueuedPromptsRef, queuedPrompts,
    setComposerError, setInput, setSlashHidden, setDraftAttachments, setEditingQueuedPromptId, setMovedQueuedPromptId,
    EMPTY_DRAFT_ATTACHMENTS, draftStore, draftKey, taRef, clearSessionPromptQueue, setWorkspaceOpenRequests, workspaceOpenSequenceRef,
    currentSurface, surfacePane, dispatchRightSurface } = context

  const steerQueuedPrompt = useCallback((messageId: string): void => {
    if (steerInFlightRef.current.size > 0) return
    let queued: QueuedPrompt | undefined
    for (const queue of sessionPromptQueues.values()) {
      const index = queue.findIndex((prompt) => prompt.messageId === messageId)
      if (index < 0) continue
      if (index === 0 && queuedStartInFlightRef.current) {
        setComposerError('队首消息正在启动，不能同时作为 Steer 发送')
        return
      }
      queued = queue[index]
      break
    }
    if (!queued) return
    const localState = steerStateForMessage(queued.steer, steerEvidenceByMessageId.get(messageId))
    if (isSteerRemovalBlocked(localState)) return
    const active = [...session.turns].reverse().find((turn) => !turn.done && !turn.error)
    const capability = active ? latestSteerCapability(active.items) : undefined
    if (!active || !capability) {
      setComposerError('当前运行仍在等待可验证的 Steer 能力证据')
      return
    }
    if (capability.status !== 'available') {
      setComposerError(capability.reason)
      return
    }
    if (queued.attachments.length > 0 && !capability.attachments) {
      setComposerError('当前运行不支持 Steer 图片附件；原消息仍保留在队列')
      return
    }
    const providerId = queued.request.providerId
    const expectedExternalSessionId = queued.request.expectedExternalSessionId
    if (!providerId || typeof expectedExternalSessionId !== 'string' || !expectedExternalSessionId) {
      setComposerError('队列消息缺少可信 Provider 或会话身份，未发送 Steer')
      return
    }
    const activeIdentity = active as typeof active & Partial<Pick<ActiveRun, 'providerId' | 'agentProfileId' | 'cwd' | 'externalSessionId' | 'sessionId'>>
    const activeProviderId = [...active.items].reverse().find((event) => event.providerId)?.providerId
    const requestCwd = queued.request.cwd ?? activeIdentity.cwd
    if (!activeSteerIdentityMatches({
      request: { providerId, agentProfileId: queued.request.agentProfileId, cwd: requestCwd, expectedExternalSessionId },
      active: {
        providerId: activeIdentity.providerId ?? activeProviderId,
        agentProfileId: activeIdentity.agentProfileId,
        cwd: activeIdentity.cwd,
        externalSessionId: activeSessionIdRef.current ?? activeIdentity.externalSessionId,
        sessionId: activeIdentity.sessionId
      },
    })) {
      setComposerError('当前运行身份已变化，未将消息发送到另一个会话')
      return
    }
    if (typeof window.scry.steer !== 'function') {
      setSessionPromptQueues((current) => updateQueuedPromptByMessageId(current, messageId, (prompt) => ({
        ...prompt,
        steer: { status: 'unavailable', message: '当前 Scry preload 不支持 Steer，消息未发送；请重启到当前版本' }
      })))
      return
    }
    steerInFlightRef.current.add(messageId)
    setSessionPromptQueues((current) => updateQueuedPromptByMessageId(current, messageId, (prompt) => ({
      ...prompt,
      steer: { status: 'pending' }
    })))
    const request = {
      runId: active.runId,
      providerId,
      messageId,
      prompt: queued.text,
      attachments: queued.attachments.map((attachment) => ({ ...attachment })),
      expectedExternalSessionId,
      ...(queued.request.agentProfileId ? { agentProfileId: queued.request.agentProfileId } : {}),
      ...(requestCwd ? { cwd: requestCwd } : {})
    }
    void Promise.resolve()
      .then(() => window.scry.steer!(request))
      .then((result) => {
        steerInFlightRef.current.delete(messageId)
        if (result.status === 'accepted') {
          setSessionPromptQueues((current) => updateQueuedPromptByMessageId(current, messageId, () => null))
          return
        }
        setSessionPromptQueues((current) => updateQueuedPromptByMessageId(current, messageId, (prompt) => ({
          ...prompt,
          steer: { status: result.status, message: result.message }
        })))
      })
      .catch((error) => {
        steerInFlightRef.current.delete(messageId)
        setSessionPromptQueues((current) => updateQueuedPromptByMessageId(current, messageId, (prompt) => ({
          ...prompt,
          steer: {
            status: 'unknown',
            message: `Steer 调用结果未知：${error instanceof Error ? error.message : String(error)}`
          }
        })))
      })
  }, [session.turns, sessionPromptQueues, steerEvidenceByMessageId])

  const removeQueuedPrompt = (messageId: string): void => {
    const index = queuedPrompts.findIndex((candidate) => candidate.messageId === messageId)
    if (index < 0) return
    if (index === 0 && queuedStartInFlightRef.current) {
      setComposerError('队首消息正在启动，完成前不能移除')
      return
    }
    const prompt = queuedPrompts[index]
    const state = steerStateForMessage(prompt.steer, steerEvidenceByMessageId.get(messageId))
    if (steerInFlightRef.current.has(messageId) || isSteerRemovalBlocked(state)) {
      setComposerError(state?.status === 'unknown' ? '结果未知的 Steer 不能移除；请先核对 Provider 回执' : 'Steer 正在提交，完成前不能移除')
      return
    }
    if (index === 0) queuedStartPendingRef.current = false
    setSessionPromptQueues((current) => updateQueuedPromptByMessageId(current, messageId, () => null))
    const removed = queuedPrompts[index]
    if (removed) pausedQueuedPromptsRef.current.delete(removed.messageId)
  }
  // 编辑队列消息：把这条文本放回输入框，原条目留在队列里并标为编辑中。
  // 附件不回到输入框（原 DraftAttachment 的预览已释放），仍随这条消息留在队列项上。
  const editQueuedPrompt = (messageId: string): void => {
    const index = queuedPrompts.findIndex((candidate) => candidate.messageId === messageId)
    if (index < 0) return
    const prompt = queuedPrompts[index]
    if (index === 0 && queuedStartInFlightRef.current) {
      setComposerError(QUEUE_COPY.editTitleStarting)
      return
    }
    const state = steerStateForMessage(prompt.steer, steerEvidenceByMessageId.get(messageId))
    if (steerInFlightRef.current.has(messageId) || state?.status === 'pending') {
      setComposerError(QUEUE_COPY.editTitlePending)
      return
    }
    if (state?.status === 'unknown') {
      setComposerError(QUEUE_COPY.editTitleUnknown)
      return
    }
    // 不静默覆盖用户正在打的字：输入框非空时不进入编辑态。
    const currentDraft = draftStore.getSnapshot().get(draftKey)
    if ((currentDraft?.input ?? '').trim() || (currentDraft?.attachments ?? EMPTY_DRAFT_ATTACHMENTS).length > 0) {
      setComposerError(QUEUE_COPY.editTitleDraft)
      return
    }
    setComposerError(null)
    setEditingQueuedPromptId(messageId)
    setMovedQueuedPromptId(null)
    setInput(prompt.text)
    setSlashHidden(true)
    window.setTimeout(() => taRef.current?.focus(), 0)
  }
  const cancelQueuedPromptEdit = (): void => {
    setEditingQueuedPromptId(null)
    setInput('')
    setSlashHidden(true)
    window.setTimeout(() => taRef.current?.focus(), 0)
  }
  const removeDraftAttachment = (id: string): void => {
    setDraftAttachments((prev) => {
      const next = prev.filter((attachment) => attachment.id !== id)
      const removed = prev.filter((attachment) => attachment.id === id)
      for (const attachment of removed) {
        if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
      }
      return next
    })
  }
  const openWorkspaceFile = useCallback((target: WorkspaceFileTarget): void => {
    if (!cwd) return
    setComposerError(null)
    void window.scry.workspaceResolveFile(target).then(async (resolved) => {
      if (resolved.mode === 'external') {
        const open = resolved.cwd === cwd ? window.scry.workspaceOpenExternal : window.scry.workspaceOpenKnownExternal
        await open({ cwd: resolved.cwd, path: resolved.path })
        return
      }
      surfacePane.restore()
      const request = { id: ++workspaceOpenSequenceRef.current, cwd: resolved.cwd, path: resolved.path }
      setWorkspaceOpenRequests((previous) => new Map(previous).set(currentSurface.id, request))
      dispatchRightSurface({ type: 'open', kind: 'files' })
    }).catch((error) => {
      setComposerError(error instanceof Error ? error.message : String(error))
    })
  }, [cwd, surfacePane.restore, currentSurface.id, dispatchRightSurface])
  const addWorkspaceReference = useCallback((entry: WorkspaceEntry): void => {
    setInput((current) => appendWorkspaceReference(current, workspaceReferenceToken(entry)))
    window.setTimeout(() => taRef.current?.focus(), 0)
  }, [setInput])
  const stopRun = async (): Promise<void> => {
    clearSessionPromptQueue()
    await session.stopRun()
  }
  const [historyOlderLoading, setHistoryOlderLoading] = useState(false)
  // 更早轮次按需取回：请求只带当前窗口的 offset，main 侧再用 revision + 会话身份栅栏；
  // 过期响应由 prependOlderTurns 丢弃，不会把别的会话的轮次拼进时间线。
  const loadOlderTurns = async (): Promise<void> => {
    const historyWindow = session.historyWindow
    if (!historyWindow?.hasOlder || historyOlderLoading) return
    if (typeof window.scry.loadSessionOlder !== 'function' || !selectedProviderSessionId) return
    setHistoryOlderLoading(true)
    try {
      const page = await window.scry
        .loadSessionOlder(
          {
            providerId: integrations.selectedProviderId,
            agentProfileId: integrations.providerContext.agentProfileId,
            cwd: cwd ?? '',
            externalSessionId: selectedProviderSessionId
          },
          { before: historyWindow.offset }
        )
        .catch(() => null)
      session.prependOlderTurns(historyWindow.sessionId, page)
    } finally {
      setHistoryOlderLoading(false)
    }
  }

  return { steerQueuedPrompt, removeQueuedPrompt, editQueuedPrompt, cancelQueuedPromptEdit, removeDraftAttachment, openWorkspaceFile, addWorkspaceReference, stopRun, loadOlderTurns, historyOlderLoading }
}
