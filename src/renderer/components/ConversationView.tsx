import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { ConversationPage, ConversationPreview, ConversationSendRequest, ConversationSummary } from '@shared/conversation-api'
import { conversationItemKey } from '@shared/conversation'
import type { ProviderId } from '@shared/provider'
import { composerDraftKey, type ComposerDraftStore } from '../composer-drafts'
import { chatBottomStickinessAfterScroll, observeChatBottomLayout, scrollChatToBottomIfNeeded } from '../chat-scroll'
import { UserMessage, AssistantTurn } from './ChatTurn'
import { WorkspaceFileLinkProvider } from './MarkdownImpl'
import { ModalFrame } from './Modals'
import '../conversation.css'

const deliveryLabels = { pending: '投递中', unknown: '投递结果未知', not_sent: '未投递', accepted: '已确认接收', imported: '导入记录' }
const providerNames = { claude: 'Claude', codex: 'Codex', qoder: 'Qoder', opencode: 'OpenCode', pi: 'Pi' }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

function HistoryBody({ conversationId, item }: { conversationId: string; item: ConversationPreview['missingItems'][number] }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!open || text !== undefined || error) return
    let cancelled = false
    void window.scry.conversations.readItem(conversationId, item.ref).then(
      text => { if (!cancelled) setText(text) },
      error => { if (!cancelled) setError(message(error)) }
    )
    return () => { cancelled = true }
  }, [open, conversationId, item.ref, text, error])
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>查看完整正文</summary>
    {error ? <p role="alert">正文读取失败：{error}</p> : text === undefined ? <p role="status">正在读取权威归档…</p> : <pre className="unified-history-body">{text}</pre>}
  </details>
}

/** A logical conversation never adopts a native session into the legacy composer. */
export function ConversationView({ conversation, draftStore, onChanged }: {
  conversation: ConversationSummary
  draftStore: ComposerDraftStore
  onChanged: () => void
}) {
  const draftKey = composerDraftKey({ providerId: 'conversation', cwd: conversation.cwd, sessionId: conversation.id })
  const drafts = useSyncExternalStore(draftStore.subscribe, draftStore.getSnapshot)
  const input = drafts.get(draftKey)?.input ?? ''
  const [page, setPage] = useState<ConversationPage>()
  const [before, setBefore] = useState<number>()
  const [reload, setReload] = useState(0)
  const [latestRequest, setLatestRequest] = useState(0)
  const [live, setLive] = useState<ActiveRun>()
  const [providerId, setProviderId] = useState<ProviderId>('claude')
  const [preview, setPreview] = useState<ConversationPreview>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmFresh, setConfirmFresh] = useState(false)
  const [attempt, setAttempt] = useState<ConversationSendRequest>()
  const [attemptReadback, setAttemptReadback] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [working, setWorking] = useState(false)
  const [event, setEvent] = useState<TraceEvent>()
  const historyRef = useRef<HTMLElement>(null)
  const followLatest = useRef(true)
  const openingLatest = useRef(true)
  const busyRef = useRef(false)
  const previewButton = useRef<HTMLButtonElement>(null)
  const refreshButton = useRef<HTMLButtonElement>(null)
  const initialized = useRef(false)
  const refreshGeneration = useRef(0)
  const lastRevision = useRef<number>()
  const mounted = useRef(true)
  const changedRef = useRef(onChanged)
  changedRef.current = onChanged

  const refresh = useCallback(async (): Promise<ConversationPage | undefined> => {
    const generation = ++refreshGeneration.current
    const next = await window.scry.conversations.read(conversation.id, before)
    const run = next.summary.activeRunId
      ? (await window.scry.activeRuns()).find((candidate) => candidate.runId === next.summary.activeRunId)
      : undefined
    if (!mounted.current || generation !== refreshGeneration.current) return
    setPage(next)
    setLive(run)
    if (lastRevision.current !== next.summary.revision) {
      lastRevision.current = next.summary.revision
      changedRef.current()
    }
    if (!initialized.current) {
      initialized.current = true
      const previous = next.turns.at(-1)?.providerId
      if (previous === 'claude' || previous === 'codex') setProviderId(previous)
    }
    return next
  }, [conversation.id, before])

  const activeRunId = page?.summary.activeRunId
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    // Read authoritative snapshots, not a second trace consumer with competing ACKs.
    // Poll only during a run, after each read settles; idle history is event-driven.
    const update = async (): Promise<void> => {
      try {
        if (activeRunId) {
          const active = (await window.scry.activeRuns()).find((run) => run.runId === activeRunId)
          if (disposed) return
          setLive(active)
          if (!active) await refresh()
        } else await refresh()
      } catch (error) { if (!disposed) setError(message(error)); return }
      if (!disposed && activeRunId) timer = setTimeout(() => { void update() }, 1000)
    }
    void update()
    const off = window.scry.onDataUpdated?.(() => { void refresh().catch((error) => { if (!disposed) setError(message(error)) }) })
    return () => { disposed = true; mounted.current = false; ++refreshGeneration.current; clearTimeout(timer); off?.() }
  }, [refresh, activeRunId, reload])

  useEffect(() => {
    const history = historyRef.current
    if (history) return observeChatBottomLayout(history, () => before === undefined && (openingLatest.current || followLatest.current))
  }, [before])

  useLayoutEffect(() => {
    if (before !== undefined) return
    scrollChatToBottomIfNeeded(historyRef.current, openingLatest.current || followLatest.current)
    if (!page || !openingLatest.current) return
    const frame = requestAnimationFrame(() => {
      scrollChatToBottomIfNeeded(historyRef.current, true)
      openingLatest.current = false
      followLatest.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [page, live, before, latestRequest])

  const showLatest = (): void => {
    openingLatest.current = true
    followLatest.current = true
    // Commit the notice/composer geometry before pinning. A scroll event from
    // the old viewport must not be mistaken for the user leaving the bottom.
    setLatestRequest(value => value + 1)
    if (before !== undefined) {
      setPage(undefined)
      setBefore(undefined)
    }
  }

  const setInput = (value: string): void => {
    draftStore.update((current) => new Map(current).set(draftKey, { input: value, attachments: [] }))
  }
  const blocked = Boolean(page?.summary.activeRunId || page?.summary.blockedReason)
  const prepare = async (): Promise<void> => {
    if (busyRef.current || blocked || attempt || !input.trim()) return
    busyRef.current = true
    setWorking(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await window.scry.conversations.preview(conversation.id, { providerId })
      if (!mounted.current) return
      setPreview(next)
      setSelected(new Set(next.missingItems.map((item) => conversationItemKey(item.ref))))
      setConfirmFresh(false)
    } catch (error) { if (mounted.current) setError(message(error)) }
    finally { busyRef.current = false; if (mounted.current) setWorking(false) }
  }
  const send = async (request: ConversationSendRequest): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setWorking(true)
    setAttempt(request)
    setAttemptReadback(false)
    setError(undefined)
    try {
      const result = await window.scry.conversations.send(request)
      // Read the synchronous draft: do not erase a newer edit or another conversation.
      draftStore.update((current) => current.get(draftKey)?.input === request.prompt
        ? new Map(current).set(draftKey, { input: '', attachments: [] }) : current)
      if (!mounted.current) return
      setAttempt(undefined)
      setPreview(undefined)
      showLatest()
      setNotice(result.disposition === 'duplicate' ? '已找到原发送记录；没有再次发送。' : '请求已登记。接收与执行结果以本轮证据为准。')
      changedRef.current()
      await refresh().catch((error) => { if (mounted.current) setError(`请求已登记，但回读失败：${message(error)}`) })
    } catch (error) {
      if (mounted.current) {
        setError(message(error))
        // A rejected IPC reply does not prove that input was not delivered.
        setNotice('草稿已保留。核对原发送会复用同一命令 ID，不自动重新执行。')
        try { setAttemptReadback(Boolean(await refresh())) } catch (readError) { setError(`${message(error)}；回读失败：${message(readError)}`) }
      }
    } finally { busyRef.current = false; if (mounted.current) setWorking(false) }
  }
  const confirm = (): void => {
    if (!preview || preview.continuation.kind === 'blocked') return
    void send({
      conversationId: conversation.id,
      expectedRevision: preview.revision,
      expectedContinuationKey: preview.target.continuationKey,
      commandId: crypto.randomUUID(),
      providerId: preview.target.providerId,
      prompt: draftStore.getSnapshot().get(draftKey)?.input ?? '',
      selectedItems: preview.missingItems.filter((item) => selected.has(conversationItemKey(item.ref))).map((item) => item.ref),
      confirmFresh
    })
  }
  const closePreview = (): void => {
    if (working) return
    setPreview(undefined)
    // The trigger was disabled during async planning, so the dialog cannot infer
    // its return target from document.activeElement when it finally mounts.
    window.requestAnimationFrame(() => (attempt ? refreshButton.current : previewButton.current)?.focus())
  }

  return <main className="unified-conversation" aria-label="统一对话" data-conversation-id={conversation.id}>
    <header className="unified-header">
      <div><h1>{page?.summary.title ?? conversation.title}</h1><small>同一对话 · 独立原生上下文 · {page?.summary.turnCount ?? conversation.turnCount} 轮</small></div>
      <code title={conversation.cwd}>{conversation.cwd}</code>
    </header>
    <div className="unified-pagination">
      <button className="btn" disabled={page?.nextBeforeOrdinal === undefined} onClick={() => setBefore(page?.nextBeforeOrdinal)}>更早记录</button>
      <span>{page?.turns.length ? `第 ${page.turns[0].ordinal}–${page.turns.at(-1)!.ordinal} 轮` : '尚无记录'} · 每页最多 40 轮</span>
      <button className="btn" disabled={before === undefined} onClick={showLatest}>最近记录</button>
      <button ref={refreshButton} className="btn" onClick={() => { setError(undefined); setReload((value) => value + 1) }}>刷新证据</button>
    </div>
    <section ref={historyRef} className="chat chat-transcript unified-history" aria-label="统一对话历史" onScroll={(event) => {
      followLatest.current = chatBottomStickinessAfterScroll(event.currentTarget, openingLatest.current)
    }}>
      {!page && <p role="status">{error ? '读取失败；请刷新证据重试。' : '正在读取对话…'}</p>}
      {page?.turns.length === 0 && <p className="unified-empty">从 Claude 或 Codex 开始。切换时会先展示缺失的历史，再由你确认发送。</p>}
      {page?.turns.map((turn) => {
        const active = live?.runId === turn.runId ? live : undefined
        const history = active ?? turn.history
        return <article className="unified-turn" key={turn.runId} data-run-id={turn.runId}>
          <header><b>{providerNames[turn.providerId]}</b><span>第 {turn.ordinal} 轮 · {deliveryLabels[turn.delivery.status]}</span></header>
          {history ? <WorkspaceFileLinkProvider workspaces={[conversation.cwd]} onOpen={(target) => {
            void window.scry.workspaceResolveFile(target).then((resolved) => {
              const open = resolved.cwd === conversation.cwd ? window.scry.workspaceOpenExternal : window.scry.workspaceOpenKnownExternal
              return open({ cwd: resolved.cwd, path: resolved.path })
            }).catch((error) => setError(message(error)))
          }}>
            <UserMessage text={history.userText} attachments={history.attachments} />
            <AssistantTurn turn={{ ...history, runId: turn.runId, done: history.done === true, providerId: turn.providerId, cwd: conversation.cwd }} selectedId={event?.id ?? null} onSelect={setEvent}
              pendingQuestions={active?.pendingQuestions}
              onAnswerQuestion={async (response) => {
                if (!await window.scry.answerQuestion(response)) throw new Error('问题已关闭或不再属于本轮')
                await refresh()
              }} />
          </WorkspaceFileLinkProvider> : <p role="status">{turn.unavailableReason ?? '等待权威归档；不以空内容替代缺失证据。'}</p>}
          {(turn.delivery.status === 'unknown' || turn.delivery.status === 'not_sent') && <p role="note">{turn.delivery.reason}</p>}
        </article>
      })}
    </section>
    <footer className="composer runtime-composer unified-composer">
      {page?.summary.blockedReason && <p role="status">{page.summary.blockedReason}</p>}
      {!preview && error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {Boolean(live?.pendingQuestions?.length) && <p role="status">本轮等待你的回答。 <button className="btn unified-question-jump" onClick={showLatest}>查看待回答问题</button></p>}
      <div className="composer-shell evidence-composer-shell">
        <textarea aria-label="统一对话消息" value={input} onChange={(event) => setInput(event.target.value)} disabled={working || Boolean(attempt) || Boolean(preview)} placeholder="输入当前请求；历史由单独的确认步骤补齐" rows={3} />
      </div>
      <div className="composer-bottom">
        <fieldset className="unified-provider" disabled={blocked || working || Boolean(attempt) || Boolean(preview)}>
          <legend>下一轮 · 默认配置</legend>
          {(['claude', 'codex'] as const).map((provider) => <label key={provider}>
            <input type="radio" name="conversation-provider" aria-label={`${providerNames[provider]} 默认配置`} checked={providerId === provider} onChange={() => setProviderId(provider)} /> {providerNames[provider]}
          </label>)}
        </fieldset>
        <span className="unified-scope">纯文本 · 默认模型/审批；附件、原生命令（含 $skill）、Steer 暂不可用</span>
        {page?.summary.activeRunId ? <button className="btn" onClick={() => {
          void window.scry.stop(page.summary.activeRunId!).then((requested) => setNotice(requested ? '已请求停止；等待 Provider 和归档收敛。' : '运行已结束或无法停止；请查看本轮证据。')).catch((error) => setError(message(error)))
        }}>请求停止</button> : <button ref={previewButton} className="btn primary" disabled={!page || blocked || working || Boolean(attempt) || !input.trim()} onClick={() => { void prepare() }}>预览并发送</button>}
      </div>
      {attempt && !preview && <button className="btn" disabled={working} onClick={() => { void send(attempt) }}>核对原发送</button>}
    </footer>
    {preview && <ModalFrame labelledBy="conversation-preview-title" className="unified-preview" onClose={closePreview}>
      <h2 id="conversation-preview-title">确认发送给 {providerNames[preview.target.providerId]}</h2>
      <p>{preview.continuation.kind === 'resume' ? '恢复兼容的原生上下文，仅补齐你选择的缺失内容。' : '没有兼容的原生上下文；需要新建。不会伪装成原生恢复。'}</p>
      <p>已接收的内容不会重复发送。工具执行、思考过程和用量不作为历史重放。</p>
      <fieldset disabled={working || Boolean(attempt)}><legend>缺失历史 · 已选 {selected.size} / {preview.missingItems.length} 项</legend>
        <div className="unified-history-selection">{preview.missingItems.map((item) => {
          const key = conversationItemKey(item.ref)
          return <div key={key}><label><input type="checkbox" checked={selected.has(key)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })} />
            第 {item.ordinal} 轮 · {providerNames[item.providerId]} · {item.role === 'user' ? '用户请求' : '助手回复'}
          </label><HistoryBody conversationId={conversation.id} item={item} /></div>
        })}</div>
        {preview.missingItems.length === 0 && <p>无缺失历史。</p>}
        <p>未勾选的内容仍记为缺失，以后可补齐。</p>
        {preview.continuation.kind === 'fresh' && <label><input type="checkbox" checked={confirmFresh} onChange={(event) => setConfirmFresh(event.target.checked)} /> 我确认创建新的原生上下文</label>}
      </fieldset>
      <details><summary>本次当前请求（独立于历史）</summary><pre>{attempt?.prompt ?? input}</pre></details>
      {error && <p role="alert">{error}</p>}
      {attempt && <p>原请求可能已接收，请先核对历史。返回编辑不会撤销已发送的内容。</p>}
      {attempt ? <div className="unified-actions">
        <button className="btn" disabled={working} onClick={closePreview}>关闭，查看记录</button>
        <button className="btn" disabled={working} onClick={() => { void send(attempt) }}>核对原发送</button>
        <button className="btn" disabled={working || blocked || !attemptReadback} onClick={() => { setAttempt(undefined); setPreview(undefined) }}>保留草稿，返回编辑</button>
      </div> : <div className="unified-actions">
        <button className="btn" disabled={working} onClick={closePreview}>取消，不发送</button>
        <button className="btn primary" disabled={working || (preview.continuation.kind === 'fresh' && !confirmFresh)} onClick={confirm}>确认发送</button>
      </div>}
    </ModalFrame>}
    {event && <ModalFrame labelledBy="conversation-event-title" onClose={() => setEvent(undefined)}>
      <h2 id="conversation-event-title">本轮事件证据</h2><pre className="unified-event">{JSON.stringify(event, null, 2)}</pre><button className="btn" onClick={() => setEvent(undefined)}>关闭</button>
    </ModalFrame>}
  </main>
}
