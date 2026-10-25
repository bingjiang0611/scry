import { useCallback, useEffect, useLayoutEffect, type MutableRefObject, type RefObject, type Dispatch, type SetStateAction } from 'react'
import type { SlashCmd, TraceEvent } from '@shared/trace'
import type { AgentSteerEvidence } from '@shared/runtime'
import type { AgentStartRequest } from '@shared/runtime'
import type { useAgentSession } from './hooks/useAgentSession'
import type { useIntegrations } from './hooks/useIntegrations'
import type { QueuedPrompt, DraftAttachment, SessionPromptQueues } from './app-model'
import type { createComposerDraftStore } from './composer-drafts'
import type { useChatNavigation } from './hooks/useChatNavigation'
import { runtimeProviderForAgentId } from '@shared/runtime'
import { useAppSlashCommands } from './hooks/useAppSlashCommands'
import { nextDrainableQueuedPrompt, dequeueStartedPromptFromSessions, enqueuePrompt, editedPromptToTail, shouldQueuePrompt, commitDraftOnDispatch, inputAfterSuccessfulSubmit, inputAfterFailedSubmit, attachmentsAfterFailedSubmit } from './app-model'
import { isSteerDrainBlocked, steerStateForMessage } from './steer'
import { chatBottomStickinessAfterScroll, observeChatBottomLayout, scrollChatToBottomIfNeeded } from './chat-scroll'
import { attachmentsAfterSuccessfulSubmit, fileToDraftAttachment, clipboardAttachmentToDraft, inputAttachments } from './composer-drafts'
import { requestDockBadgePermission } from './dock-badge-permission'
import { useAppPromptStart } from './hooks/useAppPromptStart'

export interface AppComposerContext {
  view: 'chat' | 'conversation' | 'analytics' | 'meta-prompts' | 'remote'
  cwd: string | null
  setCwd: (cwd: string | null) => void
  loadProjects: () => void
  openWorkspaceRun: (cwd: string, sessionId: string, runId: string) => Promise<void>
  sessionSelectionSeqRef: MutableRefObject<number>
  viewRef: MutableRefObject<'chat' | 'conversation' | 'analytics' | 'meta-prompts' | 'remote'>
  setView: Dispatch<SetStateAction<'chat' | 'conversation' | 'analytics' | 'meta-prompts' | 'remote'>>
  switchingAgentRef: MutableRefObject<string | undefined>
  movedQueuedPromptId: string | null
  EMPTY_DRAFT_ATTACHMENTS: DraftAttachment[]
  draftStore: ReturnType<typeof createComposerDraftStore>
  draftKey: string
  session: ReturnType<typeof useAgentSession>
  integrations: ReturnType<typeof useIntegrations>
  chatNavigation: ReturnType<typeof useChatNavigation>
  scrollRef: RefObject<HTMLDivElement>
  taRef: RefObject<HTMLTextAreaElement>
  selectedProviderSessionId: string | null
  sessionLoading: boolean
  sendBlockedReason: string | null | undefined
  setComposerError: Dispatch<SetStateAction<string | null>>
  setComposerSubmitting: Dispatch<SetStateAction<boolean>>
  setInput: Dispatch<SetStateAction<string>>
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>
  clearDraftAttachments: () => void
  setSlashHidden: Dispatch<SetStateAction<boolean>>
  setSlashSel: Dispatch<SetStateAction<number>>
  slash: ReturnType<typeof useAppSlashCommands>
  draftStartPendingRef: MutableRefObject<boolean>
  activeSessionIdRef: MutableRefObject<string | null>
  cwdRef: MutableRefObject<string | null>
  draftContextRef: MutableRefObject<{ providerId: import('@shared/provider').ProviderId; agentProfileId?: string; cwd: string | null }>
  localDraftOwnersRef: MutableRefObject<Map<string, { key: string; providerId: import('@shared/provider').ProviderId; agentProfileId?: string; cwd: string | null }>>
  localRunIdsRef: MutableRefObject<Set<string>>
  localStartsRef: MutableRefObject<Map<string, string>>
  selectSessionId: (id: string | null) => void
  migrateRightSurface: (from: string, to: string) => void
  shouldStickToBottomRef: MutableRefObject<boolean>
  openingSessionBottomRef: MutableRefObject<boolean>
  queuedStartPendingRef: MutableRefObject<boolean>
  queuedStartInFlightRef: MutableRefObject<boolean>
  queuedDrainGenerationRef: MutableRefObject<number>
  queueKeyRef: MutableRefObject<string>
  pausedQueuedPromptsRef: MutableRefObject<Set<string>>
  steerInFlightRef: MutableRefObject<Set<string>>
  queuedPrompts: QueuedPrompt[]
  setQueuedPrompts: Dispatch<SetStateAction<QueuedPrompt[]>>
  setSessionPromptQueues: Dispatch<SetStateAction<SessionPromptQueues>>
  sessionPromptQueues: SessionPromptQueues
  editingQueuedPromptId: string | null
  setEditingQueuedPromptId: Dispatch<SetStateAction<string | null>>
  setMovedQueuedPromptId: Dispatch<SetStateAction<string | null>>
  steerEvidenceByMessageId: ReadonlyMap<string, AgentSteerEvidence & { eventId: string }>
}

export function useAppComposer(context: AppComposerContext) {
  const { slashCmds, slashReason, slashLoading, slashSel, setSlashSel, slashHidden, setSlashHidden, slashToken, slashOpen, retrySlash, refreshSlashCatalog } = context.slash

  const { view, cwd, viewRef, setView, switchingAgentRef, movedQueuedPromptId, EMPTY_DRAFT_ATTACHMENTS, draftStore, draftKey, session, integrations, chatNavigation, scrollRef, taRef, selectedProviderSessionId,
    sessionLoading, sendBlockedReason, setComposerError, setComposerSubmitting, setInput, setDraftAttachments,
    clearDraftAttachments, draftStartPendingRef, activeSessionIdRef, cwdRef,
    shouldStickToBottomRef, openingSessionBottomRef,
    queuedStartPendingRef, queuedStartInFlightRef, queuedDrainGenerationRef, queueKeyRef, pausedQueuedPromptsRef,
    steerInFlightRef, queuedPrompts, setQueuedPrompts, setSessionPromptQueues, editingQueuedPromptId,
    setEditingQueuedPromptId, setMovedQueuedPromptId, steerEvidenceByMessageId
  } = context

  const pickSlash = (cmd: SlashCmd): void => {
    // 填入 "/name "，让用户补参数或直接 Enter 发送（有空白后 slashToken 变 null，菜单自然关闭）
    setInput('/' + cmd.name + ' ')
    setSlashHidden(true)
    taRef.current?.focus()
  }

  useEffect(() => {
    if (view !== 'chat') return
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      if (chatNavigation.active.current) return
      shouldStickToBottomRef.current = chatBottomStickinessAfterScroll(
        el,
        openingSessionBottomRef.current
      )
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [cwd, view])

  useEffect(() => {
    if (view !== 'chat') return
    const el = scrollRef.current
    if (!el) return
    return observeChatBottomLayout(el, () => openingSessionBottomRef.current || shouldStickToBottomRef.current)
  }, [cwd, selectedProviderSessionId, view])

  useLayoutEffect(() => {
    if (view !== 'chat') return
    const openingSession = openingSessionBottomRef.current
    scrollChatToBottomIfNeeded(
      scrollRef.current,
      openingSession || shouldStickToBottomRef.current
    )
    if (!openingSession || sessionLoading) return

    // History replacement can emit a scroll event while the old scrollTop is
    // clamped against the empty transcript. Keep the opening intent through
    // that event, then re-apply it after the loaded transcript has laid out.
    const frame = requestAnimationFrame(() => {
      if (!openingSessionBottomRef.current || chatNavigation.active.current) return
      scrollChatToBottomIfNeeded(scrollRef.current, true)
      openingSessionBottomRef.current = false
      shouldStickToBottomRef.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedProviderSessionId, session.turns, sessionLoading, view])

  const openTurnInChat = useCallback(
    (runId: string, ev?: TraceEvent | null, target: 'turn' | 'event' = 'turn'): void => {
      // Explicit navigation owns scrolling, including layout work already queued
      // by history opening or virtual row materialization.
      openingSessionBottomRef.current = false
      shouldStickToBottomRef.current = false
      if (ev) session.setSelected(ev)
      if (viewRef.current !== 'conversation') setView('chat')
      chatNavigation.navigate(runId, target === 'event' ? ev?.id : undefined)
    },
    [session.setSelected, chatNavigation.navigate]
  )

  const currentRunRequest = useCallback(
    (): Omit<AgentStartRequest, 'prompt' | 'attachments'> => ({
      cwd: cwdRef.current ?? undefined,
      expectedExternalSessionId: activeSessionIdRef.current,
      providerId: integrations.selectedProviderId,
      agentId: integrations.selectedId,
      agentProfileId: integrations.providerContext.agentProfileId,
      runtimeProvider: runtimeProviderForAgentId(integrations.selectedId),
      model: integrations.runControls.model,
      effort: integrations.runControls.effort,
      permissionMode: integrations.runControls.permissionMode
    }),
    [
      integrations.runControls.effort,
      integrations.runControls.model,
      integrations.runControls.permissionMode,
      integrations.selectedId,
      integrations.selectedProviderId,
      integrations.providerContext.agentProfileId
    ]
  )

  const startPrompt = useAppPromptStart(context, currentRunRequest)

  useEffect(() => {
    // 历史页尚未恢复完成时不能启动队列，否则会用上一会话残留的 busy/身份状态发送。
    if (sessionLoading || session.busy) return
    const queueKey = draftKey
    if (queuedStartPendingRef.current) return
    const queued = nextDrainableQueuedPrompt(queuedPrompts, editingQueuedPromptId)
    if (!queued) return
    // Preserve FIFO and pause barriers, including the render before ACK removal commits.
    if (pausedQueuedPromptsRef.current.has(queued.messageId) || steerInFlightRef.current.has(queued.messageId) ||
      isSteerDrainBlocked(steerStateForMessage(queued.steer, steerEvidenceByMessageId.get(queued.messageId)))) return
    const queuedAgentId = queued.request.agentId ?? queued.request.providerId
    if (!queuedAgentId || !integrations.agents.some((agent) => agent.id === queuedAgentId)) {
      setComposerError(`队列中的 ${queuedAgentId ?? '未知'} Provider 当前不可用；消息仍保留在队列`)
      return
    }
    const next = queued
    queuedStartPendingRef.current = true
    queuedStartInFlightRef.current = true
    const queueGeneration = queuedDrainGenerationRef.current
    void startPrompt(next.text, next.attachments, next.request, queueKey)
      .then(() => {
        // 即使期间切到了别的会话，也要从它原属的会话队列中移除已成功启动的消息。
        setSessionPromptQueues((current) => dequeueStartedPromptFromSessions(current, next))
        pausedQueuedPromptsRef.current.delete(next.messageId)
        if (queueGeneration !== queuedDrainGenerationRef.current || queueKeyRef.current !== queueKey) return
        queuedStartInFlightRef.current = false
        queuedStartPendingRef.current = false
      })
      .catch((error) => {
        pausedQueuedPromptsRef.current.add(next.messageId)
        if (queueGeneration !== queuedDrainGenerationRef.current || queueKeyRef.current !== queueKey) return
        // Keep the failed item at the head and pause automatic draining. Removing that
        // head is the explicit "skip" action, so later prompts can never overtake it.
        queuedStartInFlightRef.current = false
        queuedStartPendingRef.current = true
        setComposerError(`${error instanceof Error ? error.message : String(error)}；这条消息仍保留在队列，队列已暂停`)
      })
  }, [draftKey, editingQueuedPromptId, integrations.agents, queuedPrompts, session.busy, sessionLoading, startPrompt, steerEvidenceByMessageId])

  // 队列项离开队列（移除、Steer 被接受、被自动出队）后，编辑态必须跟着结束，
  // 否则输入框会停在一个已经不存在的队列条目上。
  useEffect(() => {
    if (!editingQueuedPromptId) return
    if (queuedPrompts.some((prompt) => prompt.messageId === editingQueuedPromptId)) return
    setEditingQueuedPromptId(null)
  }, [editingQueuedPromptId, queuedPrompts])

  useEffect(() => {
    if (!movedQueuedPromptId) return
    const timer = window.setTimeout(() => setMovedQueuedPromptId(null), 2500)
    return () => window.clearTimeout(timer)
  }, [movedQueuedPromptId])

  // Agent / 目录就绪后立即预取；用户输入 / 时只展示缓存，不再现场等 Provider。
  useEffect(refreshSlashCatalog, [refreshSlashCatalog])

  // 过滤结果变化时高亮项回到顶部
  useEffect(() => {
    setSlashSel(0)
  }, [slashToken])

  const addPastedImages = useCallback(async (files: File[]): Promise<void> => {
    const next = (await Promise.all(files.map((file, index) => fileToDraftAttachment(file, index)))).filter(
      (attachment): attachment is DraftAttachment => attachment != null
    )
    if (next.length === 0) return
    setDraftAttachments((prev) => [...prev, ...next])
  }, [setDraftAttachments])

  const addClipboardImage = useCallback(async (): Promise<void> => {
    const attachment = await window.scry.clipboardImage()
    if (!attachment) return
    setDraftAttachments((prev) => [...prev, clipboardAttachmentToDraft(attachment)])
  }, [setDraftAttachments])

  const send = async (): Promise<void> => {
    if (switchingAgentRef.current) return
    const draft = draftStore.getSnapshot().get(draftKey)
    const input = draft?.input ?? ''
    const draftAttachments = draft?.attachments ?? EMPTY_DRAFT_ATTACHMENTS
    const text = input.trim()
    const attachments = inputAttachments(draftAttachments)
    if (!text && attachments.length === 0) return
    if (draftStartPendingRef.current || sessionLoading) return
    if (sendBlockedReason) {
      setComposerError(sendBlockedReason)
      return
    }
    // Dock badge 权限是可选装饰，而 macOS 的系统弹窗可能很久不返回（新安装的 bundle 就是
    // permission=default）。曾经在这里 await 它：一旦弹窗不返回，send() 就卡在进入 submitting 之前，
    // 按钮既不禁用也不报错，点击完全没反应。发送不能等它。
    void requestDockBadgePermission()
    if (shouldQueuePrompt(session.busy, queuedPrompts.length, queuedStartPendingRef.current)) {
      const request = currentRunRequest()
      if (editingQueuedPromptId) {
        const editingId = editingQueuedPromptId
        const moved = editedPromptToTail(queuedPrompts, editingId, text, attachments)
        // 队列在点击与提交之间变了（例如刚自动出队）时不能丢文本：退回普通入队。
        if (moved.next) {
          setQueuedPrompts(moved.queue)
          setMovedQueuedPromptId(moved.next.messageId)
        } else {
          setQueuedPrompts((queue) => enqueuePrompt(queue, text, attachments, request))
        }
        pausedQueuedPromptsRef.current.delete(editingId)
        setEditingQueuedPromptId(null)
      } else {
        setQueuedPrompts((queue) => enqueuePrompt(queue, text, attachments, request))
      }
      setInput('')
      clearDraftAttachments()
      setSlashHidden(true)
      setComposerError(null)
      return
    }
    const originalInput = input
    const submittedAttachments = draftAttachments
    const submittedIds = new Set(submittedAttachments.map((attachment) => attachment.id))
    setComposerError(null)
    draftStartPendingRef.current = true
    setComposerSubmitting(true)
    try {
      const commit = (): void => {
        setInput((current) => inputAfterSuccessfulSubmit(current, originalInput))
        setDraftAttachments((current) => attachmentsAfterSuccessfulSubmit(current, submittedIds))
        setSlashHidden(true)
      }
      if (draft?.workspace && activeSessionIdRef.current === null) {
        // Preparation can outlive this renderer. Keep the durable draft until a known ACK.
        await startPrompt(text, attachments)
        commit()
      } else {
        await commitDraftOnDispatch(() => startPrompt(text, attachments), commit)
      }
      for (const attachment of submittedAttachments) {
        if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
      }
    } catch (error) {
      // Admission can still fail after the optimistic paint. Put the submitted draft back without
      // overwriting anything the user typed or pasted while main was starting the Provider.
      setInput((current) => inputAfterFailedSubmit(current, originalInput))
      setDraftAttachments((current) => attachmentsAfterFailedSubmit(current, submittedAttachments))
      setComposerError(error instanceof Error ? error.message : String(error))
    } finally {
      draftStartPendingRef.current = false
      setComposerSubmitting(false)
    }
  }
  return { pickSlash, addPastedImages, addClipboardImage, send, openTurnInChat, slashCmds, slashReason, slashLoading, slashSel, setSlashSel, slashHidden, setSlashHidden, slashToken, slashOpen, retrySlash, refreshSlashCatalog }
}
