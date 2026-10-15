// A conversation that executes on a saved remote Scry desktop. It renders the same
// ChatView as local sessions; only the controller differs. The host owns Provider
// install, credentials, files and archive, so this view never falls back to local
// runtime state: an offline, unknown or forgotten host keeps the draft and blocks send.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { runtimeProviderForAgentId } from '@shared/runtime'
import type { AgentModelRef, AgentPermissionMode, AgentQuestionResponse, AgentRunControlCatalog, AgentRunControls } from '@shared/runtime'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import { createPortal } from 'react-dom'
import { RightSurfacePanel } from './RightSurfacePanel'
import { OverviewPanel } from './OverviewPanel'
import type { RightSurfaceAction, RightSurfaceKind, RightSurfaceState } from '../right-surface'
import type {
  DesktopRemoteContext,
  DesktopRemoteHistory,
  DesktopRemoteIntent,
  DesktopRemoteRunStatus,
  RemoteProviderRef,
  RemoteSessionRef
} from '@shared/desktop-remote'
import type { DetectedAgent } from '../env'
import type { Turn } from '../format'
import type { ComposerDraftStore } from '../composer-drafts'
import { refreshDesktopConnections, useDesktopConnections } from '../hooks/useDesktopConnections'
import { refreshRemoteCatalog, useRemoteCatalogs } from '../hooks/useRemoteCatalogs'
import { ChatView } from './ChatView'
import { bridge, defaultOption, desktopProviderKey, historyTurns, RemoteFiles, shouldQueryUnknownIntent } from './DesktopRemote'
import './desktop-remote.css'
import './remote-location.css'

const NO_ATTACHMENTS: never[] = []
const NO_QUEUE: never[] = []
const NO_SLASH: never[] = []

export function remoteDraftKey(connectionId: string, cwd: string, externalSessionId?: string): string {
  return JSON.stringify(['remote', connectionId, cwd, externalSessionId ?? 'new'])
}

// Remote Provider ids are a fixed set without ':', so `${id}:${profile}` is injective.
export function remoteAgentId(provider: Pick<RemoteProviderRef, 'id' | 'agentProfileId'>): string {
  return provider.agentProfileId ? `${provider.id}:${provider.agentProfileId}` : provider.id
}

// The host's labels describe the host ("本机完全访问" means the host user). Viewed
// from this Mac that wording is wrong, so name the executing host explicitly.
export function remotePermissionOption(option: { id: string; label: string; description?: string }, host: string): AgentRunControlCatalog['permissions'][number] {
  const label = option.label.replace(/^本机/, '')
  return {
    id: option.id as AgentPermissionMode,
    label: `${label} · ${host}`,
    description: option.id === 'full_access'
      ? `跳过审批；Agent 以 ${host} 上的用户权限运行`
      : option.description ?? `在 ${host} 上运行`
  }
}

export function remoteRunControlCatalog(provider: RemoteProviderRef | undefined, host: string): AgentRunControlCatalog {
  if (!provider) return { models: [], permissions: [] }
  return {
    models: (provider.models ?? []).map((model) => ({
      model: { id: model.id, ...(model.providerId ? { providerId: model.providerId } : {}) },
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
      ...(model.isDefault ? { isDefault: true } : {}),
      efforts: model.efforts ?? provider.efforts ?? []
    })),
    permissions: (provider.permissions ?? []).map((option) => remotePermissionOption(option, host))
  }
}

function initialControls(provider: RemoteProviderRef | undefined): AgentRunControls {
  const model = provider?.models?.find((option) => option.id === provider.modelId) ??
    provider?.models?.find((option) => option.isDefault) ?? provider?.models?.[0]
  return {
    ...(model ? { model: { id: model.id, ...(model.providerId ? { providerId: model.providerId } : {}) } } : {}),
    effort: defaultOption(model?.efforts ?? provider?.efforts),
    permissionMode: (defaultOption(provider?.permissions) ?? 'default') as AgentPermissionMode
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface RemoteChatProps {
  connectionId: string
  cwd: string
  session?: RemoteSessionRef
  draftStore: ComposerDraftStore
  onDraftInput: (key: string, value: string) => void
  scrollRef: RefObject<HTMLDivElement>
  textareaRef: RefObject<HTMLTextAreaElement>
  renderLocationPicker: (menu: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode
  onSessionAdopted: (externalSessionId: string) => void
  surface: {
    target: HTMLElement | null
    state: RightSurfaceState
    onAction: (action: RightSurfaceAction) => void
  }
}

export function RemoteChat({
  connectionId,
  cwd,
  session,
  draftStore,
  onDraftInput,
  scrollRef,
  textareaRef,
  renderLocationPicker,
  onSessionAdopted,
  surface
}: RemoteChatProps) {
  const api = bridge()
  const { connections, error: readError } = useDesktopConnections()
  const connection = connections.find((item) => item.id === connectionId)
  const connected = !readError && connection?.state === 'connected'
  const host = connection?.label ?? '远程主机'
  const catalog = useRemoteCatalogs().get(connectionId)?.catalog
  const catalogReady = catalog !== undefined
  const [providerSelection, setProviderSelection] = useState(session ? desktopProviderKey({ id: session.providerId, agentProfileId: session.agentProfileId }) : '')
  const [sessionId, setSessionId] = useState<string | undefined>(session?.externalSessionId)
  const [controls, setControls] = useState<AgentRunControls>({ permissionMode: 'default' })
  const [turns, setTurns] = useState<Turn[]>([])
  const [selected, setSelected] = useState<TraceEvent | null>(null)
  const [historyEvidence, setHistoryEvidence] = useState<Pick<DesktopRemoteHistory, 'status' | 'reason' | 'hasOlder' | 'before' | 'snapshot'> | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)
  const [runStatus, setRunStatus] = useState<(DesktopRemoteRunStatus & { runId: string }) | null>(null)
  const [intents, setIntents] = useState<DesktopRemoteIntent[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const generation = useRef(0)
  const provider = catalog?.providers.find((item) => desktopProviderKey(item) === providerSelection)
  const providerId = provider?.id ?? ''
  const context = useMemo<DesktopRemoteContext>(() => ({ cwd, providerId, ...(provider?.agentProfileId ? { agentProfileId: provider.agentProfileId } : {}), ...(sessionId ? { externalSessionId: sessionId } : {}) }), [cwd, provider?.agentProfileId, providerId, sessionId])
  const contextKey = JSON.stringify([providerSelection, sessionId ?? ''])
  const previousContextKey = useRef<string | undefined>()
  const contextGeneration = useRef(0)
  const pollSequence = useRef(0)
  const pollInFlight = useRef(false)
  const adoptingSession = useRef(false)
  const adoptedIntent = useRef<DesktopRemoteIntent | undefined>()
  const draftKey = remoteDraftKey(connectionId, cwd, sessionId)
  const readInput = () => draftStore.getSnapshot().get(draftKey)?.input ?? ''
  const input = useSyncExternalStore(draftStore.subscribe, readInput, readInput)

  // A new draft picks the host's first available Provider once the catalog arrives.
  // An existing session keeps its recorded Provider even when the host removed it.
  useEffect(() => {
    if (providerSelection || !catalog) return
    const first = catalog.providers.find((item) => item.available) ?? catalog.providers[0]
    if (first) setProviderSelection(desktopProviderKey(first))
  }, [catalog, providerSelection])

  useEffect(() => {
    if (connected) void refreshRemoteCatalog(connectionId)
  }, [connected, connectionId])

  // Changing Provider/profile or session is a different execution context: clear
  // transcript, run state and controls. Session adoption keeps the run it adopted.
  useEffect(() => {
    if (previousContextKey.current === contextKey) return
    previousContextKey.current = contextKey
    contextGeneration.current += 1
    const preserveAdoptedRun = adoptingSession.current
    adoptingSession.current = false
    if (!preserveAdoptedRun) { adoptedIntent.current = undefined; setActiveRun(null); setRunStatus(null) }
    setStatus(null); setError(null); setPollError(null); setHistoryError(null); setHistoryEvidence(null); setTurns([])
  }, [contextKey])
  // Controls start from host defaults whenever the context changes or its Provider
  // first resolves from the catalog; later catalog refreshes keep the user's choice.
  const providerResolved = provider !== undefined
  useEffect(() => {
    setControls(initialControls(provider))
  }, [contextKey, providerResolved])

  useEffect(() => {
    if (!connected || !catalogReady || !providerId || !sessionId) {
      if (!sessionId) { setTurns([]); setHistoryEvidence(null) }
      setHistoryLoading(false)
      return
    }
    const sequence = ++generation.current
    setHistoryError(null)
    setHistoryLoading(true)
    void api.history(connectionId, context).then((history) => {
      if (sequence !== generation.current) return
      setTurns(historyTurns(history))
      setHistoryEvidence({ status: history.status, reason: history.reason, hasOlder: history.hasOlder, before: history.before, snapshot: history.snapshot })
    }).catch((reason) => { if (sequence === generation.current) setHistoryError(errorText(reason)) })
      .finally(() => { if (sequence === generation.current) setHistoryLoading(false) })
    return () => { generation.current += 1 }
  }, [api, catalogReady, connectionId, connected, context, historyRevision, providerId, sessionId])

  useEffect(() => {
    if (!connected || !catalogReady || !providerId) return
    let cancelled = false
    const poll = async (): Promise<void> => {
      if (pollInFlight.current) return
      pollInFlight.current = true
      const sequence = ++pollSequence.current
      try {
        const pending = await api.intents(connectionId)
        if (cancelled || sequence !== pollSequence.current) return
        const activeIntent = pending.filter((intent) => intentMatches(intent, context) && intent.runId).sort((left, right) => left.createdAt - right.createdAt).at(-1) ??
          (adoptedIntent.current ? pending.find((intent) => intent.intentId === adoptedIntent.current?.intentId) : undefined)
        setIntents(pending)
        if (!activeIntent?.runId) { setActiveRun(null); setRunStatus(null); setPollError(null); return }
        const nextStatus = await api.runStatus(connectionId, activeIntent.runId)
        if (cancelled || sequence !== pollSequence.current) return
        setRunStatus({ ...nextStatus, runId: activeIntent.runId })
        if (nextStatus.externalSessionId && !context.externalSessionId && !activeIntent.context.externalSessionId) {
          adoptedIntent.current = activeIntent
          adoptingSession.current = true
          // Text typed while the first run was starting belongs to the adopted session.
          const pendingKey = remoteDraftKey(connectionId, cwd)
          const pendingDraft = draftStore.getSnapshot().get(pendingKey)?.input
          if (pendingDraft) {
            onDraftInput(remoteDraftKey(connectionId, cwd, nextStatus.externalSessionId), pendingDraft)
            onDraftInput(pendingKey, '')
          }
          setSessionId(nextStatus.externalSessionId)
          onSessionAdopted(nextStatus.externalSessionId)
        }
        // Terminal status retires the main-process receipt. Refresh history even
        // if the last trace read fails, before the next poll drops that receipt.
        if (nextStatus.state === 'settled' || nextStatus.state === 'failed') {
          setHistoryRevision((revision) => revision + 1)
          void refreshRemoteCatalog(connectionId)
        }
        if (nextStatus.scryRunId) {
          const run = await api.trace(connectionId, context, nextStatus.scryRunId)
          if (cancelled || sequence !== pollSequence.current) return
          setActiveRun(run)
        } else setActiveRun(null)
        setPollError(null)
      } catch (reason) { if (!cancelled && sequence === pollSequence.current) setPollError(errorText(reason)) }
      finally { pollInFlight.current = false }
    }
    void poll(); const timer = window.setInterval(() => { void poll() }, 1500)
    return () => { cancelled = true; pollSequence.current += 1; window.clearInterval(timer) }
  }, [api, catalogReady, connectionId, connected, context, providerId])

  const runControlCatalog = useMemo(() => remoteRunControlCatalog(provider, host), [host, provider])
  const chosenModel = provider?.models?.find((option) => option.id === controls.model?.id && (option.providerId ?? '') === (controls.model?.providerId ?? ''))
  const availableEfforts = chosenModel?.efforts ?? provider?.efforts
  const validEffort = controls.effort && availableEfforts?.some((option) => option.id === controls.effort) ? controls.effort : undefined
  const validPermissionMode = provider?.permissions?.some((option) => option.id === controls.permissionMode) ? controls.permissionMode : undefined
  const displayTurns = useMemo(() => {
    if (!activeRun) return turns
    const active: Turn = {
      runId: activeRun.runId,
      providerId: activeRun.providerId,
      agentProfileId: activeRun.agentProfileId,
      cwd: activeRun.cwd,
      externalSessionId: activeRun.externalSessionId,
      userText: activeRun.userText,
      attachments: activeRun.attachments,
      items: activeRun.items,
      done: activeRun.done,
      error: activeRun.error,
      errorHint: activeRun.errorHint
    }
    return [...turns.filter((turn) => turn.runId !== activeRun.runId), active]
  }, [activeRun, turns])
  const currentIntent = intents.filter((intent) => intentMatches(intent, context)).sort((left, right) => left.createdAt - right.createdAt).at(-1) ??
    (adoptedIntent.current ? intents.find((intent) => intent.intentId === adoptedIntent.current?.intentId) : undefined)
  // A previous turn's status is not evidence for the newly submitted receipt.
  const currentRunStatus = runStatus?.runId === currentIntent?.runId ? runStatus : null
  // Same gate as the host ledger: a listed run or an unknown receipt blocks another send.
  const runActive = Boolean(currentIntent && (currentIntent.status === 'unknown' || currentIntent.runId))
  const projectAvailable = catalog?.projects.some((project) => project.path === cwd) ?? false
  const contextAvailable = connected && Boolean(provider?.available) && projectAvailable

  const sendBlockedReason = !connection
    ? '这台主机已不在保存列表中；草稿已保留，不会改用本机执行'
    : !connected
      ? `${host} 未连接；草稿已保留，连接后再发送`
      : !catalog
        ? `正在读取 ${host} 的项目与 Provider`
        : !projectAvailable
          ? `${host} 上已没有这个项目；不会代选其他目录`
          : !provider
            ? '原 Provider / profile 在主机上已不可用；不会代选其他运行环境'
            : !provider.available
              ? `${provider.label} 在 ${host} 上不可用`
              : runActive
                ? '远程运行进行中；远程会话不支持排队，结束后再发送'
                : null

  const submit = async (): Promise<void> => {
    const text = input.trim()
    if (!contextAvailable || !text || submitting || runActive) return
    const submittedGeneration = contextGeneration.current
    const submittedKey = draftKey
    setSubmitting(true); setError(null); setStatus(null)
    try {
      const intent = await api.submit(connectionId, {
        context,
        prompt: text,
        ...(chosenModel ? { modelId: chosenModel.id, modelProviderId: chosenModel.providerId } : {}),
        ...(validEffort ? { effort: validEffort } : {}),
        ...(validPermissionMode ? { permissionMode: validPermissionMode } : {})
      })
      onDraftInput(submittedKey, '')
      if (submittedGeneration !== contextGeneration.current) return
      setIntents((current) => [...current.filter((item) => item.intentId !== intent.intentId), intent])
      if (shouldQueryUnknownIntent(intent)) {
        const queried = await api.intentStatus(connectionId, intent.intentId)
        if (submittedGeneration !== contextGeneration.current) return
        setIntents((current) => current.map((item) => item.intentId === queried.intentId ? queried : item))
      }
    } catch (reason) {
      if (submittedGeneration === contextGeneration.current) { setError(errorText(reason)); setStatus(null) }
    } finally { setSubmitting(false) }
  }
  const checkUnknown = async (intent: DesktopRemoteIntent): Promise<void> => {
    const checkedGeneration = contextGeneration.current
    try {
      const checked = await api.intentStatus(connectionId, intent.intentId)
      if (checkedGeneration !== contextGeneration.current) return
      setIntents((current) => current.map((item) => item.intentId === checked.intentId ? checked : item))
      setStatus(null)
    } catch (reason) { if (checkedGeneration === contextGeneration.current) setError(errorText(reason)) }
  }
  const stop = async (): Promise<void> => {
    const runId = currentIntent?.runId
    if (!runId) { setError('当前没有可停止的远端运行。'); return }
    try { await api.stop(connectionId, runId); setStatus('已请求停止，等待远端确认。') } catch (reason) { setError(errorText(reason)) }
  }
  const answer = async (response: AgentQuestionResponse): Promise<void> => {
    const runId = currentIntent?.runId
    if (!connected || !runId) { const reason = new Error('远端未连接或问题所属运行已不可用。'); setError(reason.message); throw reason }
    try { await api.answer(connectionId, runId, response); setStatus('已发送回答。') } catch (reason) { setError(errorText(reason)); throw reason }
  }
  const loadOlderHistory = async (): Promise<void> => {
    if (!connected || !historyEvidence?.hasOlder || historyEvidence.before === undefined || !sessionId) return
    const sequence = ++generation.current
    try {
      const history = await api.history(connectionId, context, historyEvidence.before, historyEvidence.snapshot)
      if (sequence !== generation.current) return
      setTurns((current) => [...historyTurns(history), ...current])
      setHistoryError(null)
      setHistoryEvidence({ status: history.status, reason: history.reason, hasOlder: history.hasOlder, before: history.before, snapshot: history.snapshot })
    } catch (reason) { if (sequence === generation.current) setHistoryError(errorText(reason)) }
  }
  const connect = useCallback(async (): Promise<void> => {
    setConnecting(true); setError(null)
    try {
      await api.connect(connectionId)
      await refreshDesktopConnections()
      await refreshRemoteCatalog(connectionId)
    } catch (reason) { setError(errorText(reason)) } finally { setConnecting(false) }
  }, [api, connectionId])

  // Map host Providers to the shared picker. Unavailable entries stay visible and
  // disabled; a session whose Provider vanished keeps a placeholder, never a substitute.
  const missingAgentId = providerSelection && catalog && !provider
    ? remoteAgentId({ id: (JSON.parse(providerSelection) as [string, string])[0], agentProfileId: (JSON.parse(providerSelection) as [string, string])[1] || undefined })
    : null
  const agents = useMemo<DetectedAgent[]>(() => {
    const listed = (catalog?.providers ?? []).map((item) => ({ id: remoteAgentId(item), name: item.label, bin: item.id, path: `${host} · ${item.id}` }))
    if (missingAgentId) listed.push({ id: missingAgentId, name: '原 Provider / profile 已不可用', bin: '', path: host })
    return listed
  }, [catalog, host, missingAgentId])
  const unavailableAgentIds = useMemo(() => new Set([
    ...(catalog?.providers ?? []).filter((item) => !item.available).map(remoteAgentId),
    ...(missingAgentId ? [missingAgentId] : [])
  ]), [catalog, missingAgentId])
  const selectedAgentId = provider ? remoteAgentId(provider) : missingAgentId ?? ''

  const unknownIntent = intents.find((intent) => intent.status === 'unknown' && intentMatches(intent, context))
  const noticeError = error ?? pollError ?? historyError
  const notice = !connected
    ? {
        tone: 'blocked' as const,
        text: !connection
          ? '这台主机已不在保存列表中。草稿会保留，不会改用本机执行。'
          : readError
            ? `无法确认 ${host} 的连接状态。草稿会保留，不会改用本机执行。`
            : connection.state === 'pairing'
              ? `${host} 尚未批准此设备。请在“主机”页完成配对。`
              : `${host} 未连接。草稿会保留，连接后不会自动发送。`,
        ...(connection && connection.state === 'disconnected' && !readError
          ? { action: { label: connecting ? '正在连接…' : '连接', onClick: () => void connect(), disabled: connecting } }
          : {})
      }
    : noticeError
      ? { tone: 'error' as const, text: noticeError }
      : unknownIntent
        ? { tone: 'blocked' as const, text: '提交结果未知；Scry 不会盲目重发同一提示词。', action: { label: '检查远端状态', onClick: () => void checkUnknown(unknownIntent) } }
      : currentRunStatus?.state === 'unknown'
        ? { tone: 'blocked' as const, text: `远程运行结果未知${currentRunStatus.detail ? ` · ${currentRunStatus.detail}` : ''}；不会自动重试。` }
        // Stop/answer notes remain relevant while the run is in flight.
        : status && (submitting || runActive)
          ? { tone: 'blocked' as const, text: status }
          // Receipt acknowledgement is not dispatch. Only this run's host state
          // can retire the waiting notice, even before its first trace arrives.
          : currentIntent?.status === 'recorded' && (!currentRunStatus || currentRunStatus.state === 'recorded')
            ? { tone: 'blocked' as const, text: '已记录提交，等待远端派发…' }
            : submitting && !currentIntent
              ? { tone: 'blocked' as const, text: '正在提交到远端…' }
              : null

  const unavailable: Partial<Record<RightSurfaceKind, string>> = Object.fromEntries(
    (['source-control', 'diff', 'terminal', 'agents'] satisfies RightSurfaceKind[]).map((kind) => [
      kind, `${host} 暂未提供此工作区能力；不会改用本机工作区。`
    ])
  )

  return (
    <>
      <ChatView
        turns={displayTurns}
        selectedId={selected?.id ?? null}
        scrollRef={scrollRef}
        textareaRef={textareaRef}
        cwd={cwd}
        workspaceRoots={[]}
        recent={[]}
        agents={agents}
        selectedAgentId={selectedAgentId}
        agentLocked={Boolean(sessionId) || runActive || submitting}
        hasSelectedSession={Boolean(sessionId)}
        runControls={controls}
        runControlCatalog={runControlCatalog}
        runControlsReason={provider && runControlCatalog.models.length === 0 ? `${host} 未提供模型列表；使用 Provider 默认模型` : null}
        input={input}
        sendBlockedReason={sendBlockedReason}
        submitting={submitting}
        sessionLoading={historyLoading && displayTurns.length === 0}
        sessionEvidenceGap={sessionId && historyEvidence?.status === 'unavailable' && displayTurns.length === 0
          ? { status: 'unavailable', detail: historyEvidence.reason ?? `${host} 未提供这条会话的归档` }
          : null}
        busy={runActive && Boolean(currentIntent?.runId)}
        draftAttachments={NO_ATTACHMENTS}
        queuedPrompts={NO_QUEUE}
        slashOpen={false}
        slashLoading={false}
        slashCmds={NO_SLASH}
        slashSel={0}
        pendingQuestions={activeRun?.pendingQuestions}
        historyWindow={historyEvidence?.hasOlder && historyEvidence.before !== undefined && sessionId
          ? { sessionId, offset: 0, totalTurns: displayTurns.length, hasOlder: true, completeness: 'partial' }
          : null}
        onLoadOlderTurns={connected ? () => { void loadOlderHistory() } : undefined}
        onSelect={setSelected}
        onAnswerQuestion={answer}
        onInput={(value) => onDraftInput(draftKey, value)}
        onChooseFolder={() => {}}
        onPickRecent={() => {}}
        onRemoveRecent={() => {}}
        onRetrySlash={() => {}}
        onPickSlash={() => {}}
        onSlashSel={() => {}}
        onHideSlash={() => {}}
        onSend={() => { void submit() }}
        onStop={() => { void stop() }}
        onPasteImages={() => setError('远程会话暂不支持图片附件；请改为发送文本。')}
        onPasteClipboardImage={() => setError('远程会话暂不支持图片附件；请改为发送文本。')}
        onRemoveDraftAttachment={() => {}}
        onRemoveQueuedPrompt={() => {}}
        onSelectAgent={(agentId) => {
          const next = catalog?.providers.find((item) => remoteAgentId(item) === agentId)
          if (next?.available) setProviderSelection(desktopProviderKey(next))
        }}
        unavailableAgentIds={unavailableAgentIds}
        agentScopeLabel={`${host} 上的 Agent`}
        onRunModel={(model: AgentModelRef | undefined) => {
          const option = provider?.models?.find((item) => item.id === model?.id && (item.providerId ?? '') === (model?.providerId ?? ''))
          setControls((current) => ({ ...current, model, effort: defaultOption(option?.efforts ?? provider?.efforts) }))
        }}
        onRunEffort={(effort) => setControls((current) => ({ ...current, effort }))}
        onPermissionMode={(permissionMode) => setControls((current) => ({ ...current, permissionMode }))}
        renderLocationPicker={renderLocationPicker}
        remoteHost={host}
        composerNotice={notice}
      />
      {surface.target && createPortal(
        <RightSurfacePanel
          openIds={surface.state.openIds}
          activeId={surface.state.activeId}
          maximized={surface.state.maximized}
          unavailable={unavailable}
          onOpen={(kind) => surface.onAction({ type: 'open', kind })}
          onActivate={(kind) => surface.onAction({ type: 'activate', kind })}
          onClose={(kind) => surface.onAction({ type: 'close', kind })}
          onHide={() => surface.onAction({ type: 'hide' })}
          onToggleMaximized={() => surface.onAction({ type: 'toggle-maximized' })}
          contents={{
            overview: sessionId && historyEvidence?.status === 'unavailable' && displayTurns.length === 0
              ? <div className="surface-unavailable"><b>会话证据不可用</b><span>{historyEvidence.reason ?? `${host} 未提供这条会话的归档`}</span></div>
              : <OverviewPanel
                  turns={displayTurns} sessionId={sessionId} selected={selected}
                  runtimeProvider={runtimeProviderForAgentId(providerId)} usage={null} stats={null}
                  busy={runActive} onSelect={setSelected}
                />,
            files: contextAvailable
              ? <RemoteFiles api={api} connectionId={connectionId} context={context} onClose={() => surface.onAction({ type: 'close', kind: 'files' })} />
              : <div className="surface-unavailable"><b>文件不可用</b><span>{sendBlockedReason ?? '当前上下文不可读取文件。'}</span></div>,
            ...Object.fromEntries(Object.entries(unavailable).map(([kind, reason]) => [kind,
              <div className="surface-unavailable" key={kind}><b>远程能力不可用</b><span>{reason}</span></div>
            ]))
          }}
        />, surface.target
      )}
    </>
  )
}

function intentMatches(intent: DesktopRemoteIntent, context: DesktopRemoteContext): boolean {
  return intent.context.cwd === context.cwd && intent.context.providerId === context.providerId &&
    (intent.context.agentProfileId ?? '') === (context.agentProfileId ?? '') && (intent.context.externalSessionId ?? '') === (context.externalSessionId ?? '')
}
