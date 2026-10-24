import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react'
import type { ActiveRun } from '@shared/trace'
import type { ConversationForkRequest, ConversationMetadataChange, ConversationPage, ConversationSendRequest, ConversationSummary } from '@shared/conversation-api'
import { attachmentsAfterSuccessfulSubmit, composerDraftKey, inputAttachments, type ComposerDraftStore } from '../composer-drafts'
import { CONVERSATION_COPY } from '../constants/copy'
import { chatBottomStickinessAfterScroll, observeChatBottomLayout, scrollChatToBottomIfNeeded } from '../chat-scroll'
import { conversationTarget, prepareConversationSend } from '../conversation-handoff'
import type { Turn } from '../format'
import { runStructuralTransition } from '../structural-motion'
import { SessionChatView } from './ChatView'
import { ConversationDeleteDialog } from './ConversationDeleteDialog'
import { SessionRenameDialog } from './SessionRename'
import '../conversation.css'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
export interface ConversationProjection { conversationId: string; turns: Turn[]; busy: boolean }

/** Same chat/composer, separate durable ownership from each native session. */
export function ConversationView({ conversation, draftStore, chatProps, initialAgentId, onChanged, onProjection, onOpenConversation }: {
  conversation: ConversationSummary
  draftStore: ComposerDraftStore
  chatProps: ComponentProps<typeof SessionChatView>
  initialAgentId?: string
  onChanged: () => void
  onProjection: (projection: ConversationProjection) => void
  onOpenConversation: (conversation: ConversationSummary) => void
}) {
  const draftKey = composerDraftKey({ providerId: 'conversation', cwd: conversation.cwd, sessionId: conversation.id })
  const drafts = useSyncExternalStore(draftStore.subscribe, draftStore.getSnapshot)
  const input = drafts.get(draftKey)?.input ?? ''
  const [page, setPage] = useState<ConversationPage>()
  const [before, setBefore] = useState<number>()
  const [reload, setReload] = useState(0)
  const [latestRequest, setLatestRequest] = useState(0)
  const [live, setLive] = useState<ActiveRun>()
  const [attempt, setAttempt] = useState<{ request: ConversationSendRequest; attachments: Array<{ id: string; previewUrl: string }> }>()
  const [forkAttempt, setForkAttempt] = useState<ConversationForkRequest>()
  const [attemptReadback, setAttemptReadback] = useState(false)
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
  const historyRef = chatProps.scrollRef
  const navigation = chatProps.scrollNavigation

  const refresh = useCallback(async (): Promise<ConversationPage | undefined> => {
    const generation = ++refreshGeneration.current
    const next = await window.scry.conversations.read(conversation.id, before)
    const run = next.summary.activeRunId
      ? (await window.scry.activeRuns()).find(candidate => candidate.runId === next.summary.activeRunId)
      : undefined
    if (!mounted.current || generation !== refreshGeneration.current) return
    const commit = (): void => { setPage(next); setLive(run) }
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
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const update = async (): Promise<void> => {
      try {
        if (activeRunId) {
          const active = (await window.scry.activeRuns()).find(run => run.runId === activeRunId)
          if (disposed) return
          setLive(active)
          if (!active) await refresh()
        } else await refresh()
      } catch (error) { if (!disposed) setError(message(error)); return }
      if (!disposed && activeRunId && !document.hidden) timer = setTimeout(() => { void update() }, 1000)
    }
    const resume = (): void => { if (!document.hidden) { clearTimeout(timer); void update() } }
    void update()
    const off = window.scry.onDataUpdated?.(event => {
      if (event?.kind === 'conversation_changed' && event.conversationId === conversation.id) {
        void refresh().catch(error => { if (!disposed) setError(message(error)) })
      }
    })
    document.addEventListener('visibilitychange', resume)
    return () => {
      disposed = true; mounted.current = false; ++refreshGeneration.current
      clearTimeout(timer); off?.(); document.removeEventListener('visibilitychange', resume)
    }
  }, [refresh, activeRunId, reload, conversation.id])

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
  }, [page, live, before, latestRequest, historyRef, chatProps.focusedTurnRunId, navigation?.active])

  const turns = useMemo<Turn[]>(() => (page?.turns ?? []).flatMap(turn => {
    const history = live?.runId === turn.runId ? live : turn.history
    return history ? [{ ...history, runId: turn.runId, done: history.done === true,
      providerId: turn.providerId, cwd: conversation.cwd }] : []
  }), [page, live, conversation.cwd])
  useEffect(() => { onProjection({ conversationId: conversation.id, turns, busy: Boolean(activeRunId) }) }, [conversation.id, turns, activeRunId, onProjection])

  const showLatest = (): void => {
    navigation?.cancel()
    openingLatest.current = true
    followLatest.current = true
    setLatestRequest(value => value + 1)
    if (before !== undefined) { setPage(undefined); setBefore(undefined) }
  }
  const setInput = (value: string): void => {
    draftStore.update(current => new Map(current).set(draftKey, { ...current.get(draftKey), input: value, attachments: current.get(draftKey)?.attachments ?? [] }))
  }
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
  const send = async (original?: typeof attempt): Promise<void> => {
    const draft = draftStore.getSnapshot().get(draftKey)
    const prompt = draft?.input ?? ''
    const attachments = draft?.attachments ?? []
    const submitted = original?.attachments ?? attachments.map(({ id, previewUrl }) => ({ id, previewUrl }))
    if (busyRef.current || forkAttempt || (!original && (blockedReason || attempt || (!prompt.trim() && !attachments.length) || chatProps.sendBlockedReason))) return
    busyRef.current = true
    setWorking(true)
    setError(undefined)
    let request = original?.request
    try {
      request ??= await prepareConversationSend(window.scry.conversations, conversation.id,
        conversationTarget(chatProps.selectedAgentId, chatProps.runControls), prompt, crypto.randomUUID(), inputAttachments(attachments))
      if (!mounted.current) return
      setAttempt({ request, attachments: submitted })
      setAttemptReadback(false)
      const result = await window.scry.conversations.send(request)
      const sentPrompt = request.prompt
      const submittedIds = new Set(submitted.map(attachment => attachment.id))
      draftStore.update(current => {
        const draft = current.get(draftKey)
        if (!draft) return current
        const remaining = { input: draft.input === sentPrompt ? '' : draft.input,
          attachments: attachmentsAfterSuccessfulSubmit(draft.attachments, submittedIds) }
        const next = new Map(current)
        if (remaining.input || remaining.attachments.length) next.set(draftKey, remaining)
        else next.delete(draftKey)
        return next
      })
      for (const attachment of submitted) if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
      if (!mounted.current) return
      setAttempt(undefined)
      showLatest()
      setNotice(result.disposition === 'duplicate' ? '已找到原发送记录，没有再次发送。' : undefined)
      changedRef.current()
      await refresh().catch(error => { if (mounted.current) setError(`请求已登记，但读取状态失败：${message(error)}`) })
    } catch (error) {
      if (mounted.current) {
        setError(message(error))
        if (request) {
          setNotice('发送结果尚未确认。草稿已保留，不会自动重发。')
          try { setAttemptReadback(Boolean(await refresh())) } catch (readError) { setError(`${message(error)}；读取状态失败：${message(readError)}`) }
        }
      }
    } finally { busyRef.current = false; if (mounted.current) setWorking(false) }
  }
  const forkableRunIds = useMemo(() => new Set((page?.turns ?? []).filter(turn =>
    turn.delivery.status === 'accepted' && page?.bindings.some(binding => binding.id === turn.bindingId && binding.nativeSessionId && !binding.retiredReason))
    .map(turn => turn.runId)), [page])
  const fork = async (turn?: Turn, original?: ConversationForkRequest): Promise<void> => {
    if (!page || busyRef.current || managing || (!original && (blockedReason || attempt || forkAttempt))) return
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

  return <main className="unified-conversation conversation-chat" aria-label="对话" data-conversation-id={conversation.id}>
    <div className="conversation-toolbar">
      <strong className="conversation-title" title={conversation.cwd}>{page?.summary.title ?? conversation.title}</strong>
      <button ref={refreshButton} className="btn" onClick={() => { setError(undefined); setReload(value => value + 1) }}>刷新状态</button>
      <details className="conversation-options"><summary>对话选项</summary><div className="unified-management">
        <button className="btn" aria-label="重命名统一对话" disabled={!page || managing || working || Boolean(page?.summary.deletion)} onClick={() => setRenaming(true)}>重命名</button>
        <button className="btn" aria-label={page?.summary.pinnedAt ? '取消置顶统一对话' : '置顶统一对话'} disabled={!page || managing || working || Boolean(page?.summary.deletion)} onClick={() => { void updateMetadata({ kind: 'pin', pinned: !page?.summary.pinnedAt }).catch(error => setError(message(error))) }}>{page?.summary.pinnedAt ? '取消置顶' : '置顶'}</button>
        <button className="btn" aria-label={page?.summary.archivedAt ? '恢复统一对话' : '存档统一对话'} disabled={!page || managing || working || Boolean((page?.summary.blockedReason && page.summary.fork?.status !== 'not_sent') || page?.summary.deletion)} onClick={() => { void updateMetadata({ kind: 'archive', archived: !page?.summary.archivedAt }).catch(error => setError(message(error))) }}>{page?.summary.archivedAt ? '恢复' : '存档'}</button>
        {page?.summary.archivedAt && (page.summary.deletion?.status !== 'complete' || page.summary.deletion.retainedCopies) && <button className="btn" aria-label="删除统一对话" disabled={managing || working || Boolean(activeRunId)} onClick={() => setDeleting(true)}>{page.summary.deletion?.status === 'complete' ? '核对保留副本…' : page.summary.deletion ? '继续清理…' : '删除副本…'}</button>}
        <p>{limitation}</p>
        <p>从轮次创建原生分支不发送消息，也不回退文件。共享历史仅供查看；再次从这些轮次分支，请回到源对话。</p>
        {inherited && <p>旧原生会话未记录可验证的接续身份。迁入保留已捕获的文字，不证明恢复了旧原生上下文。</p>}
      </div></details>
    </div>
    {(page?.nextBeforeOrdinal !== undefined || before !== undefined) && <nav className="unified-pagination" aria-label="历史分页">
      <button className="btn" disabled={page?.nextBeforeOrdinal === undefined} onClick={() => setBefore(page?.nextBeforeOrdinal)}>更早记录</button>
      <span>每页最多 40 轮</span><button className="btn" disabled={before === undefined} onClick={showLatest}>最近记录</button>
    </nav>}
    {missing.map(turn => <p className="conversation-history-notice" role="status" key={turn.runId}>第 {turn.ordinal} 轮：{turn.unavailableReason ?? '正在等待运行记录'}{turn.delivery.status === 'unknown' || turn.delivery.status === 'not_sent' ? `；${turn.delivery.reason}` : ''}</p>)}
    {page?.summary.deletion && <div className="conversation-history-notice" role="status">
      {page.summary.deletion.status === 'complete' ? page.summary.deletion.retainedCopies ? '逻辑对话已删除；上次保留的共享副本可重新核对' : '对话副本已删除' : '删除未完成'}，正文不可用。草稿仍保留。
      {input && <button className="btn" onClick={() => { void window.scry.copyText(input).then(() => setNotice('已复制保留的草稿。')).catch(error => setError(message(error))) }}>复制保留的草稿</button>}
      {page.summary.deletion.result && <details><summary>删除回执与保留范围</summary>
        <ul>{page.summary.deletion.result.retained.map(item => <li key={item}>{item}</li>)}</ul>
        {page.summary.deletion.result.failed.map((failure, index) => <p key={index}>{failure.store}: {failure.error}</p>)}
      </details>}
    </div>}
    {page?.summary.fork?.status === 'accepted' && !page.summary.deletion && <div className="conversation-history-notice" role="status">
      创建分支不会发送消息或回退文件。分支点之前的历史为共享只读副本。
      <button className="btn" disabled={working} onClick={() => {
        void window.scry.conversations.read(page.summary.fork!.sourceConversationId).then(source => {
          if (mounted.current) onOpenConversation(source.summary)
        }).catch(error => { if (mounted.current) setError(message(error)) })
      }}>打开源对话</button>
    </div>}
    <SessionChatView {...chatProps}
      draftStore={draftStore} draftKey={draftKey} turns={turns} cwd={conversation.cwd} workspaceRoots={[conversation.cwd]}
      agentLocked={!page || working || Boolean(attempt || forkAttempt || blockedReason || activeRunId)} hasSelectedSession
      onInput={setInput} onSend={() => { void send() }} submitting={working} sessionLoading={!page} sessionCacheVisible={false} sessionEvidenceGap={null}
      busy={Boolean(activeRunId)} queueWhileBusy={false}
      sendBlockedReason={blockedReason ?? (forkAttempt ? '请先核对原分支请求' : attempt ? '请先核对原发送状态' : chatProps.sendBlockedReason)} composerError={error ?? null}
      composerNotice={blockedReason && !activeRunId ? { text: blockedReason, tone: 'blocked' } : notice ? { text: notice, tone: 'blocked' } : firstHandoff ? { text: '旧 Agent 的接续身份无法验证。文字历史已保留，将在新上下文继续。', tone: 'blocked' } : null}
      draftAttachments={drafts.get(draftKey)?.attachments ?? []} queuedPrompts={[]} steerCapability={null} onSteerQueuedPrompt={undefined}
      slashOpen={false} slashCmds={[]} slashLoading={false} historyWindow={null} onLoadOlderTurns={undefined}
      pendingQuestions={live?.pendingQuestions ?? []} stopStates={live?.stopState ? { [live.runId]: live.stopState } : {}}
      traceHealth={undefined} forkableRunIds={forkableRunIds} onForkTurn={!working && !attempt && !forkAttempt && !blockedReason ? turn => fork(turn) : undefined} renderLocationPicker={undefined}
      agentScopeLabel="切换只影响下一条消息；发送时自动补齐缺失历史"
      onAnswerQuestion={async response => { if (!await window.scry.answerQuestion(response)) throw new Error('问题已关闭或不再属于本轮'); await refresh() }}
      onStop={() => {
        if (activeRunId) void window.scry.stop(activeRunId).then(requested => setNotice(requested ? '已请求停止，等待本轮结束。' : '运行已结束或无法停止，请刷新状态。')).catch(error => setError(message(error)))
      }}
    />
    {forkAttempt && <div className="conversation-recovery" role="status"><button className="btn" disabled={working} onClick={() => { void fork(undefined, forkAttempt) }}>核对 / 继续原分支</button></div>}
    {attempt && <div className="conversation-recovery" role="status">
      <button className="btn" disabled={working} onClick={() => { void send(attempt) }}>核对 / 继续原发送</button>
      {attemptReadback && !page?.summary.blockedReason && <button className="btn" disabled={working} onClick={() => { setAttempt(undefined); setError(undefined); setNotice('已解除界面锁定。再次发送是新请求，可能重复执行；请先核对聊天记录。') }}>保留草稿，解除锁定</button>}
    </div>}
    {renaming && page && <SessionRenameDialog title={page.summary.title} onClose={() => setRenaming(false)} onSave={title => updateMetadata({ kind: 'rename', title })} />}
    {deleting && page && <ConversationDeleteDialog id={conversation.id} onChanged={() => { changedRef.current(); void refresh().catch(error => setError(message(error))) }} onClose={attempted => {
      setDeleting(false)
      if (attempted) requestAnimationFrame(() => refreshButton.current?.focus())
    }} />}
  </main>
}
