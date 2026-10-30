import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ConversationForkRequest, ConversationMetadataChange, ConversationPage, ConversationSummary } from '@shared/conversation-api'
import { composerDraftKey, type ComposerDraftStore } from '../composer-drafts'
import type { ConversationHostChatProps } from '../conversation-chat-props'
import { createScopedComposerHandlers } from '../composer-attachments'
import { CONVERSATION_COPY } from '../constants/conversation-copy'
import { chatBottomStickinessAfterScroll, observeChatBottomLayout, scrollChatToBottomIfNeeded } from '../chat-scroll'
import type { SideChatViewPosition } from '../side-chat-view-state'
import { applyViewRestore, type PendingViewRestore } from '../conversation-view-restore'
import { conversationTarget, prepareConversationSend } from '../conversation-handoff'
import type { Turn } from '../format'
import { resendContent, useConversationSubmission } from '../hooks/useConversationSubmission'
import { runStructuralTransition } from '../structural-motion'
import { useRunTraceStream } from '../hooks/useRunTraceStream'


import '../conversation.css'
import { ConversationViewBody } from './ConversationViewBody'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** No turn of a side chat can create a native fork; the backend refuses it as well. */
const NO_FORKABLE_RUNS: ReadonlySet<string> = new Set()

/**
 * Turns that may create a native fork. A side chat owns no native continuation of its
 * source, so it never advertises a fork action that main would reject.
 */
export function forkableRunIdsOf(
  conversation: Pick<ConversationSummary, 'sideChat'>,
  page: ConversationPage | undefined
): ReadonlySet<string> {
  if (conversation.sideChat) return NO_FORKABLE_RUNS
  return new Set((page?.turns ?? []).filter(turn =>
    turn.delivery.status === 'accepted' &&
    page?.bindings.some(binding => binding.id === turn.bindingId && binding.nativeSessionId && !binding.retiredReason))
    .map(turn => turn.runId))
}
export interface ConversationProjection { conversationId: string; turns: Turn[]; busy: boolean; atNewest: boolean }

/** Same chat/composer, separate durable ownership from each native session. */
export function ConversationView({ conversation, draftStore, chatProps, initialAgentId, onChanged, onProjection, onOpenConversation, initialViewPosition, embedded, liveVisible = true }: {
  conversation: ConversationSummary
  draftStore: ComposerDraftStore
  chatProps: ConversationHostChatProps
  initialAgentId?: string
  onChanged: () => void
  onProjection: (projection: ConversationProjection) => void
  onOpenConversation: (conversation: ConversationSummary) => void
  /**
   * Remembered position of this exact view. It is applied once, in the same commit that
   * first shows authoritative turns, so the restore never races the asynchronous page.
   */
  initialViewPosition?: SideChatViewPosition
  /**
   * The host frame already shows this conversation's title and provenance. The toolbar
   * keeps its management controls but does not repeat the title a second time.
   */
  embedded?: boolean
  /** Mounted main pane may be hidden behind a maximized terminal. */
  liveVisible?: boolean
}) {
  const draftKey = composerDraftKey({ providerId: 'conversation', cwd: conversation.cwd, sessionId: conversation.id })
  const drafts = useSyncExternalStore(draftStore.subscribe, draftStore.getSnapshot)
  const input = drafts.get(draftKey)?.input ?? ''
  const [page, setPage] = useState<ConversationPage>()
  const [before, setBefore] = useState<number>()
  const [reload, setReload] = useState(0)
  const [latestRequest, setLatestRequest] = useState(0)
  const [forkAttempt, setForkAttempt] = useState<ConversationForkRequest>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [working, setWorking] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [managing, setManaging] = useState(false)
  const managementPending = useRef(false)
  const followLatest = useRef(true)
  const openingLatest = useRef(true)
  const busyRef = useRef(false)
  const refreshButton = useRef<HTMLButtonElement>(null)
  const initialized = useRef(false)
  const refreshGeneration = useRef(0)
  const lastRevision = useRef<number>()
  const mounted = useRef(true)
  const changedRef = useRef(onChanged)
  changedRef.current = onChanged
  const selectAgentRef = useRef(chatProps.onSelectAgent)
  selectAgentRef.current = chatProps.onSelectAgent
  const scopedComposerHandlers = useRef<ReturnType<typeof createScopedComposerHandlers>>()
  /**
   * The remembered position still waiting to be applied. It survives the one bounded page
   * read a restore may request, so an anchor outside the loaded window is applied to the
   * window this restore asked for instead of to whichever page is on screen.
   */
  const pendingRestore = useRef<PendingViewRestore>()
  const restoreSeeded = useRef(false)
  if (!restoreSeeded.current) {
    restoreSeeded.current = true
    if (initialViewPosition) {
      pendingRestore.current = { conversationId: conversation.id, position: initialViewPosition, attempts: 0 }
    }
  }
  const historyRef = chatProps.scrollRef
  const navigation = chatProps.scrollNavigation

  // 权威分页是唯一的历史来源：live 输出走 run 级订阅，不再轮询所有 activeRuns。
  const refresh = useCallback(async (): Promise<ConversationPage | undefined> => {
    const generation = ++refreshGeneration.current
    const next = await window.scry.conversations.read(conversation.id, before)
    if (!mounted.current || generation !== refreshGeneration.current) return
    const commit = (): void => { setPage(next) }
    if (!initialized.current && next.turns.some(turn => turn.history)) runStructuralTransition('session', commit)
    else commit()
    if (lastRevision.current !== next.summary.revision) {
      lastRevision.current = next.summary.revision
      changedRef.current()
    }
    if (!initialized.current) {
      initialized.current = true
      const binding = next.bindings.find(binding => binding.id === next.turns.at(-1)?.bindingId)
      const agentId = initialAgentId ?? (binding && (binding.agentProfileId ?? binding.providerId))
      if (agentId) selectAgentRef.current(agentId)
    }
    return next
  }, [conversation.id, before, initialAgentId])

  const activeRunId = page?.summary.activeRunId
  // 只有正在看的这一个 run 走自己的有界流：没有可见流时读一次权威分页，不做定时轮询。
  const stream = useRunTraceStream(liveVisible ? activeRunId : undefined, () => {
    // 终态事件到达：先读回权威分页（含归档后的正式轮次），下一次渲染再让分页接管时间线。
    void refresh().catch(error => { if (mounted.current) setError(`读取本轮最终记录失败：${message(error)}`) })
  })
  const live = stream.run
  useEffect(() => {
    if (stream.status === 'limit') setNotice(CONVERSATION_COPY.liveStreamLimited)
  }, [stream.status, setNotice])
  useEffect(() => {
    mounted.current = true
    let disposed = false
    void refresh().catch(error => { if (!disposed) setError(message(error)) })
    const resume = (): void => { if (!document.hidden) void refresh().catch(() => undefined) }
    const off = window.scry.onDataUpdated?.(event => {
      if (event?.kind === 'conversation_changed' && event.conversationId === conversation.id) {
        void refresh().catch(error => { if (!disposed) setError(message(error)) })
      }
      // 本轮记录真的落库后（turn_recorded）才刷新：没有写记录就不会有这条事件。
      if (event?.kind === 'turn_recorded' && activeRunId && event.runId === activeRunId) {
        void refresh().catch(error => { if (!disposed) setError(message(error)) })
      }
    })
    document.addEventListener('visibilitychange', resume)
    return () => {
      disposed = true; mounted.current = false; ++refreshGeneration.current
      off?.(); document.removeEventListener('visibilitychange', resume)
    }
  }, [refresh, reload, conversation.id, activeRunId])

  useEffect(() => {
    const history = historyRef.current
    if (!history) return
    const scroll = (): void => {
      if (navigation?.active.current) return
      followLatest.current = chatBottomStickinessAfterScroll(history, openingLatest.current)
    }
    history.addEventListener('scroll', scroll, { passive: true })
    const unobserve = observeChatBottomLayout(history, () => !navigation?.active.current && before === undefined && (openingLatest.current || followLatest.current))
    return () => { history.removeEventListener('scroll', scroll); unobserve?.() }
  }, [before, historyRef, navigation?.active])
  useLayoutEffect(() => {
    if (navigation?.active.current) {
      openingLatest.current = false
      followLatest.current = false
      return
    }
    const restore = pendingRestore.current
    const element = historyRef.current
    if (restore && element && page && applyViewRestore({
      restore, conversationId: conversation.id, before, page, element,
      requestBefore: setBefore, follow: atBottom => { followLatest.current = atBottom },
      clear: () => { pendingRestore.current = undefined }
    })) {
      openingLatest.current = false
      return
    }
    if (before !== undefined) return
    scrollChatToBottomIfNeeded(historyRef.current, openingLatest.current || followLatest.current)
    if (!page || !openingLatest.current) return
    const frame = requestAnimationFrame(() => {
      if (!openingLatest.current || navigation?.active.current) return
      scrollChatToBottomIfNeeded(historyRef.current, true)
      openingLatest.current = false
      followLatest.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [page, live, before, latestRequest, historyRef, chatProps.focusedTurnRunId, navigation?.active,
    initialViewPosition, conversation.id])

  // live 只覆盖「本轮仍在运行」的那一格；一旦分页不再报告 activeRunId，归档后的正式轮次接管，
  // 不会把有界的 live 投影当成已完成轮次的正文。
  const turns = useMemo<Turn[]>(() => (page?.turns ?? []).flatMap(turn => {
    const liveTurn = activeRunId === turn.runId ? live : undefined
    const history = liveTurn?.runId === turn.runId ? liveTurn : turn.history
    return history ? [{ ...history, runId: turn.runId, ordinal: turn.ordinal, done: history.done === true,
      providerId: turn.providerId, cwd: conversation.cwd }] : []
  }), [page, live, activeRunId, conversation.cwd])
  useEffect(() => { onProjection({ conversationId: conversation.id, turns, busy: Boolean(activeRunId), atNewest: before === undefined }) }, [conversation.id, turns, activeRunId, before, onProjection])

  const showLatest = (): void => {
    navigation?.cancel()
    openingLatest.current = true
    followLatest.current = true
    setLatestRequest(value => value + 1)
    if (before !== undefined) { setPage(undefined); setBefore(undefined) }
  }
  // Every mutation of this draft goes through one bounded, draft-scoped owner.
  const { setInput, addPastedImages, addClipboardImage, removeDraftAttachment } =
    scopedComposerHandlers.current ??= createScopedComposerHandlers(draftStore, draftKey)
  const updateMetadata = async (change: ConversationMetadataChange): Promise<void> => {
    if (!page || managementPending.current) return
    managementPending.current = true
    setManaging(true)
    try {
      await window.scry.conversations.update(conversation.id, page.summary.revision, change)
      changedRef.current()
      await refresh()
    } finally { managementPending.current = false; setManaging(false) }
  }
  const blockedReason = !page ? '正在读取对话…' : page.summary.blockedReason ??
    (page.summary.archivedAt ? '对话已存档；恢复后可继续发送' : null)
  const submission = useConversationSubmission({
    api: window.scry.conversations, draftStore, draftKey, mounted,
    expectedRevision: () => page?.summary.revision,
    prepare: (prompt, attachments, commandId) => prepareConversationSend(window.scry.conversations, conversation.id,
      conversationTarget(chatProps.selectedAgentId, chatProps.runControls), prompt, commandId, attachments),
    onError: setError, onNotice: setNotice,
    onSubmitted: () => {
      showLatest()
      changedRef.current()
      void refresh().catch(error => { if (mounted.current) setError(`请求已登记，但读取状态失败：${message(error)}`) })
    }
  })
  const { pending, pendingHealth, working: submitting, checkPending, settlePending } = submission
  // Mount, restart and every authoritative page settle the exact command id read-only.
  // A page that predates the submission cannot answer it, and a page read while the
  // start reply is still in flight must not report a false "missing record".
  useEffect(() => {
    if (!page || submitting) return
    if (pending && page.summary.revision <= pending.expectedRevision) return
    if (pending) settlePending(pending.commandId, page.turns)
  }, [page, pending, submitting, settlePending])
  const sendBlocked = Boolean(blockedReason || forkAttempt || pending || chatProps.sendBlockedReason)
  const send = async (): Promise<void> => {
    if (busyRef.current || sendBlocked) return
    busyRef.current = true
    try { await submission.submit() } finally { busyRef.current = false }
  }
  const resend = async (): Promise<void> => {
    if (busyRef.current || !pending || pendingHealth?.kind !== 'not_sent' || blockedReason) return
    busyRef.current = true
    try { await submission.submit(resendContent(pending)) } finally { busyRef.current = false }
  }
  // A side chat owns no native continuation of the source, so it never offers a fork
  // action that main would reject anyway.
  const forkUnsupported = Boolean(conversation.sideChat)
  const forkableRunIds = useMemo(() => forkableRunIdsOf(conversation, page), [conversation, page])
  const fork = async (turn?: Turn, original?: ConversationForkRequest): Promise<void> => {
    if (!page || busyRef.current || managing || (!original && (blockedReason || pending || forkAttempt))) return
    let request = original
    if (!request) {
      const selected = page.turns.find(item => item.runId === turn?.runId)
      const binding = page.bindings.find(item => item.id === selected?.bindingId)
      if (!binding || !turn || !forkableRunIds.has(turn.runId)) throw new Error('该轮没有可执行的原生归属；共享历史请回到源对话操作')
      const sameAgent = chatProps.selectedAgentId === (binding.agentProfileId ?? binding.providerId)
      if (binding.providerId === 'pi' && (!sameAgent || chatProps.runControls.permissionMode !== 'full_access')) {
        throw new Error('请先选择该轮的 Pi Profile 并明确启用本机完全访问，再创建原生分支；不会发送消息')
      }
      request = { conversationId: conversation.id, expectedRevision: page.summary.revision, sourceRunId: turn.runId,
        commandId: crypto.randomUUID(), permissionMode: sameAgent ? chatProps.runControls.permissionMode : 'default' }
    }
    busyRef.current = true
    setWorking(true)
    setForkAttempt(request)
    setError(undefined)
    try {
      const result = await window.scry.conversations.fork(request)
      changedRef.current()
      if (!mounted.current) return
      setForkAttempt(undefined)
      onOpenConversation(result)
    } catch (error) {
      if (mounted.current) setError(`分支结果尚未确认：${message(error)}。不会自动重建；核对 / 继续使用同一条请求，宿主若尚未收到则可能首次执行。`)
    } finally { busyRef.current = false; if (mounted.current) setWorking(false) }
  }
  const missing = page?.turns.filter(turn => !turn.history && live?.runId !== turn.runId) ?? []
  const inherited = page?.bindings.some(binding => binding.retiredReason && binding.continuationKey.startsWith('unverified-legacy:'))
  const firstHandoff = inherited && page?.turns.every(turn => turn.delivery.status === 'imported')
  const limitation = CONVERSATION_COPY.handoffScope

  return <ConversationViewBody
    conversation={conversation} embedded={embedded} draftKey={draftKey} page={page} before={before} input={input} missing={missing}
    working={working || submitting} managing={managing} forkAttempt={forkAttempt}
    pending={pending} pendingHealth={pendingHealth} onCheckPending={() => { void checkPending() }} onResendPending={() => { void resend() }}
    renaming={renaming} deleting={deleting} activeRunId={activeRunId} inherited={inherited} firstHandoff={firstHandoff}
    limitation={limitation} drafts={drafts} live={live} forkableRunIds={forkableRunIds} forkUnsupported={forkUnsupported} error={error} notice={notice}
    refreshButton={refreshButton} chatProps={chatProps} setError={setError} setNotice={setNotice} setBefore={setBefore}
    showLatest={showLatest} updateMetadata={updateMetadata} setRenaming={setRenaming} setDeleting={setDeleting}
    send={send} fork={fork} refresh={refresh} onOpenConversation={onOpenConversation}
    liveHealth={stream.health}
    mounted={mounted} changedRef={changedRef} setReload={setReload} draftStore={draftStore} turns={turns} blockedReason={blockedReason}
    setInput={setInput} addPastedImages={addPastedImages} addClipboardImage={addClipboardImage} removeDraftAttachment={removeDraftAttachment}
  />
}
