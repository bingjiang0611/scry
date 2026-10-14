import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentPermissionMode, AgentQuestionResponse } from '@shared/runtime'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { Turn } from '../format'
import { AssistantTurn, UserMessage } from './ChatTurn'
import type {
  DesktopPairingResult,
  DesktopRemoteAPI,
  DesktopRemoteCatalog,
  DesktopRemoteConnection,
  DesktopRemoteContext,
  DesktopRemoteHistory,
  DesktopRemoteIntent,
  DesktopRemoteRunStatus,
  RemoteControlOption,
  RemoteProviderRef,
  RemoteSessionRef
} from '@shared/desktop-remote'
import type { WorkspaceEntry, WorkspaceFilePage } from '@shared/workspace'
import { desktopConnectionLabel, refreshDesktopConnections, useDesktopConnections } from '../hooks/useDesktopConnections'
import './desktop-remote.css'

export function desktopRemoteStateKey(connectionId: string, context: DesktopRemoteContext): string {
  return [connectionId, context.providerId, context.agentProfileId ?? '', context.cwd, context.externalSessionId ?? 'new'].join('\u0000')
}

export function desktopProviderKey(provider: Pick<RemoteProviderRef, 'id' | 'agentProfileId'>): string {
  return JSON.stringify([provider.id, provider.agentProfileId ?? ''])
}

export function shouldQueryUnknownIntent(intent: Pick<DesktopRemoteIntent, 'status'>): boolean {
  return intent.status === 'unknown'
}

export function remoteTurns(items: readonly TraceEvent[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | undefined
  for (const event of items) {
    const isBoundary = event.kind === 'human' && event.stage === 'prompt'
    if (isBoundary || !current || current.runId !== event.runId) {
      current = {
        runId: event.runId,
        providerId: event.providerId,
        agentProfileId: event.agentId,
        userText: isBoundary ? event.text ?? '' : '',
        items: [],
        done: true
      }
      turns.push(current)
    }
    current.items.push(event)
    if (event.isError && event.text) current.error = event.text
  }
  return turns
}

function historyTurns(history: { turns: Array<{ runId?: string; providerTurnId?: string; forkTurnId?: string; userText: string; attachments?: Turn['attachments']; items: TraceEvent[]; done?: boolean; error?: string; errorHint?: string }> }): Turn[] {
  return history.turns.map((turn, index) => ({ ...turn, runId: turn.runId ?? `remote-turn-${index}`, done: turn.done ?? true }))
}

function bridge(): DesktopRemoteAPI {
  return (window.scry as unknown as { desktopRemote: DesktopRemoteAPI }).desktopRemote
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function defaultOption(options: readonly RemoteControlOption[] | undefined): string | undefined {
  return options?.find((option) => option.isDefault)?.id ?? options?.[0]?.id
}

function ConnectionList({
  connections,
  selectedId,
  onSelect,
  onRefresh,
  error
}: {
  connections: DesktopRemoteConnection[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRefresh: () => void
  error: string | null
}): JSX.Element {
  return (
    <aside className="desktop-remote__connections" aria-label="远程主机">
      <div className="desktop-remote__section-head"><b>远程主机</b><button type="button" onClick={onRefresh}>刷新</button></div>
      {connections.length === 0 ? <p className="desktop-remote__muted">{error ? '主机列表读取失败。' : '尚未保存主机。'}</p> : connections.map((connection) => (
        <button
          type="button"
          key={connection.id}
          className={`desktop-remote__connection ${selectedId === connection.id ? 'is-active' : ''}`}
          onClick={() => onSelect(connection.id)}
        >
          <strong>{connection.label}</strong>
          <span>{connection.ssh.username}@{connection.ssh.hostname}:{connection.ssh.port}</span>
          <small>{desktopConnectionLabel(connection, error)}</small>
        </button>
      ))}
    </aside>
  )
}

function ClientPairForm({ onPaired }: { onPaired: (id: string) => Promise<void> }): JSX.Element {
  const [label, setLabel] = useState('')
  const [username, setUsername] = useState('')
  const [hostname, setHostname] = useState('')
  const [port, setPort] = useState('22')
  const [invitation, setInvitation] = useState('')
  const [pairing, setPairing] = useState<DesktopPairingResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pair = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const result = await bridge().pair({ label: label.trim() || hostname.trim(), ssh: { username: username.trim(), hostname: hostname.trim(), port: Number(port) }, invitation: invitation.trim() })
      setPairing(result); await onPaired(result.connection.id)
    } catch (reason) { setError(errorText(reason)) } finally { setBusy(false) }
  }
  const finish = async (): Promise<void> => {
    if (!pairing) return
    setBusy(true); setError(null)
    try { setPairing(await bridge().finishPairing(pairing.connection.id)); await onPaired(pairing.connection.id) }
    catch (reason) { setError(errorText(reason)) } finally { setBusy(false) }
  }
  return (
    <section className="desktop-remote__card">
      <h2>连接另一台 Scry 桌面</h2>
      <p className="desktop-remote__muted">在远端主机的 Scry 设置中生成 SSH 邀请，再粘贴完整邀请字符串。连接不会替换本机权限或 API。</p>
      <div className="desktop-remote__form-grid">
        <label>显示名称<input value={label} onChange={(event) => setLabel(event.target.value)} autoComplete="off" /></label>
        <label>SSH 用户名<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label>
        <label>主机名<input value={hostname} onChange={(event) => setHostname(event.target.value)} autoComplete="off" required /></label>
        <label>端口<input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" required /></label>
      </div>
      <label>邀请字符串<textarea value={invitation} onChange={(event) => setInvitation(event.target.value)} rows={4} spellCheck={false} required /></label>
      {error && <p className="desktop-remote__error" role="alert">{error}</p>}
      {!pairing ? <button type="button" onClick={() => void pair()} disabled={busy || !username.trim() || !hostname.trim() || !invitation.trim()}>配对</button> : (
        <div className="desktop-remote__pairing-result">
          <p><b>设备指纹</b></p><code>{pairing.publicKeySHA256}</code>
          <p>{pairing.state === 'pending' ? '请在远端 Scry 上确认此设备，然后点击完成。' : '设备已配对。'}</p>
          {pairing.state === 'pending' && <button type="button" onClick={() => void finish()} disabled={busy}>完成配对</button>}
        </div>
      )}
    </section>
  )
}

function ProviderControls({
  provider,
  modelId,
  effort,
  permissionMode,
  onModel,
  onEffort,
  onPermission
}: {
  provider: RemoteProviderRef
  modelId?: string
  effort?: string
  permissionMode?: AgentPermissionMode
  onModel: (id: string) => void
  onEffort: (id: string) => void
  onPermission: (mode: AgentPermissionMode) => void
}): JSX.Element {
  const models = provider.models ?? []
  const model = models.find((option) => option.id === modelId) ?? models.find((option) => option.isDefault)
  const efforts = model?.efforts ?? provider.efforts
  const permissions = provider.permissions ?? []
  return <div className="desktop-remote__controls">
    <label>模型<select value={modelId ?? model?.id ?? ''} onChange={(event) => onModel(event.target.value)} disabled={models.length === 0}>
      {models.length === 0 && <option value="">主机未提供模型列表</option>}
      {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select></label>
    <label>Effort<select value={effort ?? defaultOption(efforts) ?? ''} onChange={(event) => onEffort(event.target.value)} disabled={!efforts?.length}>
      {!efforts?.length && <option value="">主机未提供</option>}
      {efforts?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select></label>
    <label>权限<select value={permissionMode ?? ''} onChange={(event) => onPermission(event.target.value as AgentPermissionMode)} disabled={!permissions.length}>
      {!permissions.length && <option value="">主机未提供</option>}
      {permissions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select></label>
  </div>
}

function RemoteFiles({
  api,
  connectionId,
  context
}: {
  api: DesktopRemoteAPI
  connectionId: string
  context: DesktopRemoteContext
}): JSX.Element {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [file, setFile] = useState<WorkspaceFilePage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const load = useCallback(async (nextPath: string, cursor?: string) => {
    const sequence = ++generation.current
    setError(null); if (!cursor) setFile(null)
    try {
      const result = await api.files(connectionId, context, nextPath, cursor)
      if (sequence !== generation.current) return
      setEntries((current) => cursor ? [...current, ...result.entries] : result.entries)
      setNextCursor(result.nextCursor)
      setPath(nextPath)
    } catch (reason) { if (sequence === generation.current) { setError(errorText(reason)); if (!cursor) setEntries([]) } }
  }, [api, connectionId, context])
  const openFile = async (entryPath: string, offset?: number, snapshot?: string): Promise<void> => {
    const sequence = ++generation.current
    setError(null)
    try {
      const result = await api.file(connectionId, context, entryPath, offset, snapshot)
      if (sequence !== generation.current) return
      setFile((current) => offset !== undefined && current?.path === result.path ? { ...result, content: current.content + result.content } : result)
    } catch (reason) { if (sequence === generation.current) setError(errorText(reason)) }
  }
  useEffect(() => { void load('') }, [load])
  return <section className="desktop-remote__files">
    <div className="desktop-remote__section-head"><b>只读文件</b><button type="button" onClick={() => void load(path)}>刷新</button></div>
    <code className="desktop-remote__path">{path || '.'}</code>
    {error && <p className="desktop-remote__error" role="alert">{error}</p>}
    <ul>{path && <li><button type="button" onClick={() => void load(path.split('/').slice(0, -1).join('/'))}>..</button></li>}
      {entries.map((entry) => <li key={entry.path}><button type="button" onClick={() => entry.kind === 'directory' ? void load(entry.path) : void openFile(entry.path)}>{entry.kind === 'directory' ? '▸ ' : '□ '}{entry.name}</button></li>)}
    </ul>
    {nextCursor && <button type="button" onClick={() => void load(path, nextCursor)}>加载更多（列表有上限）</button>}
    {file && <div className="desktop-remote__file-preview"><div><b>{file.path}</b><button type="button" onClick={() => setFile(null)}>关闭</button></div><pre>{file.content}</pre>{file.hasMore && <><small>内容已截断；文件读取上限为 512 KiB。</small><button type="button" onClick={() => void openFile(file.path, file.nextOffset, file.snapshot)}>继续读取</button></>}</div>}
  </section>
}

function RemoteWorkspace({ connection, onDisconnect, onReconnect, connected }: {
  connection: DesktopRemoteConnection
  onDisconnect: () => Promise<void>
  onReconnect: () => Promise<void>
  connected: boolean
}): JSX.Element {
  const api = bridge()
  const [catalog, setCatalog] = useState<DesktopRemoteCatalog | null>(null)
  const [providerSelection, setProviderSelection] = useState('')
  const [cwd, setCwd] = useState('')
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [modelId, setModelId] = useState<string | undefined>()
  const [effort, setEffort] = useState<string | undefined>()
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode | undefined>()
  const [turns, setTurns] = useState<Turn[]>([])
  const [historyEvidence, setHistoryEvidence] = useState<Pick<DesktopRemoteHistory, 'status' | 'reason' | 'hasOlder' | 'before' | 'snapshot'> | null>(null)
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)
  const [runStatus, setRunStatus] = useState<DesktopRemoteRunStatus | null>(null)
  const [intents, setIntents] = useState<DesktopRemoteIntent[]>([])
  const [prompt, setPrompt] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const generation = useRef(0)
  // Reconnection refreshes catalog and history concurrently; neither cancels the other.
  const catalogGeneration = useRef(0)
  const provider = catalog?.providers.find((item) => desktopProviderKey(item) === providerSelection)
  const providerId = provider?.id ?? ''
  const context = useMemo<DesktopRemoteContext>(() => ({ cwd, providerId, ...(provider?.agentProfileId ? { agentProfileId: provider.agentProfileId } : {}), ...(sessionId ? { externalSessionId: sessionId } : {}) }), [cwd, provider?.agentProfileId, providerId, sessionId])
  const stateKey = desktopRemoteStateKey(connection.id, context)
  const previousContextKey = useRef<string | undefined>()
  const contextGeneration = useRef(0)
  const pollSequence = useRef(0)
  const pollInFlight = useRef(false)
  const adoptingSession = useRef(false)
  const adoptedIntent = useRef<DesktopRemoteIntent | undefined>()
  const selectedProvider = provider
  useEffect(() => {
    if (previousContextKey.current === stateKey) return
    previousContextKey.current = stateKey
    contextGeneration.current += 1
    const preserveAdoptedRun = adoptingSession.current
    adoptingSession.current = false
    if (!preserveAdoptedRun) { adoptedIntent.current = undefined; setActiveRun(null); setRunStatus(null) }
    setStatus(null); setError(null); setHistoryEvidence(null); setTurns([])
    const model = selectedProvider?.models?.find((option) => option.isDefault) ?? selectedProvider?.models?.[0]
    setModelId(selectedProvider?.modelId ?? model?.id)
    setEffort(defaultOption(model?.efforts ?? selectedProvider?.efforts))
    setPermissionMode(defaultOption(selectedProvider?.permissions) as AgentPermissionMode | undefined)
  }, [selectedProvider, stateKey])

  const load = useCallback(async () => {
    if (!connected) return
    const sequence = ++catalogGeneration.current
    setError(null); setStatus(null); setActiveRun(null); setRunStatus(null)
    try {
      const next = await api.catalog(connection.id)
      if (sequence !== catalogGeneration.current) return
      setCatalog(next)
      const firstProvider = next.providers.find((item) => item.available) ?? next.providers[0]
      const nextProviderKey = firstProvider ? desktopProviderKey(firstProvider) : ''
      const firstProject = next.projects[0]?.path ?? ''
      setProviderSelection((current) => current || nextProviderKey)
      setCwd((current) => current || firstProject)
      if (!nextProviderKey || !firstProject) { setError('远端未提供可用项目或 Provider。'); return }
    } catch (reason) { if (sequence === catalogGeneration.current) setError(errorText(reason)) }
  }, [api, connection.id, connected])

  useEffect(() => { void load(); return () => { catalogGeneration.current += 1 } }, [load])
  useEffect(() => {
    if (!connected) return
    if (!catalog || !providerId || !cwd || !sessionId) {
      setTurns([]); setHistoryEvidence(null)
      return
    }
    const sequence = ++generation.current
    setError(null)
    void api.history(connection.id, context).then((history) => {
      if (sequence === generation.current) {
        setTurns(historyTurns(history))
        setHistoryEvidence({ status: history.status, reason: history.reason, hasOlder: history.hasOlder, before: history.before, snapshot: history.snapshot })
      }
    }).catch((reason) => { if (sequence === generation.current) setError(errorText(reason)) })
    return () => { generation.current += 1 }
  }, [api, catalog, connection.id, connected, context, providerId, cwd, sessionId])
  useEffect(() => {
    if (!connected || !catalog || !providerId || !cwd) return
    let cancelled = false
    const poll = async (): Promise<void> => {
      if (pollInFlight.current) return
      pollInFlight.current = true
      const sequence = ++pollSequence.current
      try {
        const pending = await api.intents(connection.id)
        if (cancelled || sequence !== pollSequence.current) return
        const matchesContext = (intent: DesktopRemoteIntent): boolean => intent.context.cwd === context.cwd && intent.context.providerId === context.providerId &&
          (intent.context.agentProfileId ?? '') === (context.agentProfileId ?? '') && (intent.context.externalSessionId ?? '') === (context.externalSessionId ?? '')
        const activeIntent = pending.filter((intent) => matchesContext(intent) && intent.runId).sort((left, right) => left.createdAt - right.createdAt).at(-1) ??
          (adoptedIntent.current ? pending.find((intent) => intent.intentId === adoptedIntent.current?.intentId) : undefined)
        setIntents(pending)
        if (!activeIntent?.runId) { setActiveRun(null); setRunStatus(null); return }
        const nextStatus = await api.runStatus(connection.id, activeIntent.runId)
        if (cancelled || sequence !== pollSequence.current) return
        setRunStatus(nextStatus)
        if (nextStatus.externalSessionId && !context.externalSessionId && !activeIntent.context.externalSessionId) { adoptedIntent.current = activeIntent; adoptingSession.current = true; setSessionId(nextStatus.externalSessionId) }
        if (nextStatus.scryRunId) {
          const run = await api.trace(connection.id, context, nextStatus.scryRunId)
          if (!cancelled && sequence === pollSequence.current) setActiveRun(run)
        } else setActiveRun(null)
        if (nextStatus.state === 'settled' || nextStatus.state === 'failed') {
          const refreshed = await api.catalog(connection.id)
          if (!cancelled && sequence === pollSequence.current) setCatalog(refreshed)
        }
      } catch (reason) { if (!cancelled && sequence === pollSequence.current) setError(errorText(reason)) }
      finally { pollInFlight.current = false }
    }
    void poll(); const timer = window.setInterval(() => { void poll() }, 1500)
    return () => { cancelled = true; pollSequence.current += 1; window.clearInterval(timer) }
  }, [api, catalog, connection.id, connected, context, cwd, providerId])

  const chosenModel = provider?.models?.find((option) => option.id === modelId) ?? provider?.models?.find((option) => option.isDefault) ?? provider?.models?.[0]
  const validModelId = chosenModel?.id
  const availableEfforts = chosenModel?.efforts ?? provider?.efforts
  const validEffort = effort && availableEfforts?.some((option) => option.id === effort) ? effort : defaultOption(availableEfforts)
  const validPermissionMode = permissionMode && provider?.permissions?.some((option) => option.id === permissionMode) ? permissionMode : defaultOption(provider?.permissions) as AgentPermissionMode | undefined
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
    const without = turns.filter((turn) => turn.runId !== activeRun.runId)
    return [...without, active]
  }, [activeRun, turns])
  const contextAvailable = connected && provider?.available && catalog?.projects.some(project => project.path === cwd)
  const submit = async (): Promise<void> => {
    const text = prompt.trim(); if (!contextAvailable || !text || !providerId || !cwd || submitting || Boolean(currentIntent && (currentIntent.status === 'unknown' || currentIntent.runId))) return
    const submittedGeneration = contextGeneration.current
    const submittedContext = context
    setSubmitting(true); setError(null); setStatus('已记录提交，等待远端派发…')
    try {
      const intent = await api.submit(connection.id, { context: submittedContext, prompt: text, ...(validModelId ? { modelId: validModelId } : {}), modelProviderId: chosenModel?.providerId, ...(validEffort ? { effort: validEffort } : {}), ...(validPermissionMode ? { permissionMode: validPermissionMode } : {}) })
      if (submittedGeneration !== contextGeneration.current) return
      setPrompt(''); setIntents((current) => [...current.filter((item) => item.intentId !== intent.intentId), intent])
      if (shouldQueryUnknownIntent(intent)) {
        const queried = await api.intentStatus(connection.id, intent.intentId)
        if (submittedGeneration !== contextGeneration.current) return
        setStatus(queried.status === 'unknown' ? '提交结果未知；未自动重试，请检查远端运行状态。' : `提交状态：${queried.status}`)
      }
    } catch (reason) {
      if (submittedGeneration === contextGeneration.current) { setError(errorText(reason)); setStatus(null) }
    } finally { setSubmitting(false) }
  }
  const currentIntent = intents.filter((intent) => intent.context.cwd === context.cwd && intent.context.providerId === context.providerId &&
    (intent.context.agentProfileId ?? '') === (context.agentProfileId ?? '') && (intent.context.externalSessionId ?? '') === (context.externalSessionId ?? ''))
    .sort((left, right) => left.createdAt - right.createdAt).at(-1) ??
    (adoptedIntent.current ? intents.find((intent) => intent.intentId === adoptedIntent.current?.intentId) : undefined)
  const checkUnknown = async (intent: DesktopRemoteIntent): Promise<void> => {
    const checkedGeneration = contextGeneration.current
    try {
      const checked = await api.intentStatus(connection.id, intent.intentId)
      if (checkedGeneration !== contextGeneration.current) return
      setIntents((current) => current.map((item) => item.intentId === checked.intentId ? checked : item))
      setStatus(checked.status === 'unknown' ? '远端仍未确认此提交；不会自动重试。' : `提交状态：${checked.status}`)
    } catch (reason) { if (checkedGeneration === contextGeneration.current) setError(errorText(reason)) }
  }
  const stop = async (): Promise<void> => {
    const runId = currentIntent?.runId
    if (!runId) { setError('当前没有可停止的远端运行。'); return }
    try { await api.stop(connection.id, runId); setStatus('已请求停止，等待远端确认。') } catch (reason) { setError(errorText(reason)) }
  }
  const answer = async (response: AgentQuestionResponse): Promise<void> => {
    const runId = currentIntent?.runId
    if (!connected || !runId) { const reason = new Error('远端未连接或问题所属运行已不可用。'); setError(reason.message); throw reason }
    try { await api.answer(connection.id, runId, response); setStatus('已发送回答。') } catch (reason) { setError(errorText(reason)); throw reason }
  }
  const contextSessions = catalog?.sessions.filter((session) => session.providerId === providerId && session.cwd === cwd &&
    (session.agentProfileId ?? '') === (provider?.agentProfileId ?? '') && session.externalSessionId) ?? []
  const selectedSession = contextSessions.find((session) => session.externalSessionId === sessionId)
  const setSession = (session: RemoteSessionRef | undefined): void => {
    if (!session?.externalSessionId) { setSessionId(undefined); return }
    setSessionId(session.externalSessionId)
    setCwd(session.cwd); setProviderSelection(desktopProviderKey({ id: session.providerId, agentProfileId: session.agentProfileId }))
  }
  const loadOlderHistory = async (): Promise<void> => {
    if (!connected || !historyEvidence?.hasOlder || historyEvidence.before === undefined || !sessionId) return
    const sequence = ++generation.current
    try {
      const history = await api.history(connection.id, context, historyEvidence.before, historyEvidence.snapshot)
      if (sequence !== generation.current) return
      setTurns((current) => [...historyTurns(history), ...current])
      setHistoryEvidence({ status: history.status, reason: history.reason, hasOlder: history.hasOlder, before: history.before, snapshot: history.snapshot })
    } catch (reason) { if (sequence === generation.current) setError(errorText(reason)) }
  }
  return <div className="desktop-remote__workspace" data-state-key={stateKey}>
    <header className="desktop-remote__workspace-head">
      <div><b>执行位置：{connection.label} · 远程</b><span>{connection.ssh.hostname} · {connected ? '已连接' : '未确认连接'}</span></div>
      <div>{!connected && <button type="button" onClick={() => void onReconnect()}>连接此主机</button>}<button type="button" onClick={() => void onDisconnect()} disabled={!connected}>断开</button><button type="button" onClick={() => void load()} disabled={!connected}>重新加载</button></div>
    </header>
    {error && <p className="desktop-remote__error" role="alert">{error}</p>}
    {status && <p className="desktop-remote__status" role="status">{status}</p>}
    {!connected && <p className="desktop-remote__warning" role="status">远程主机未连接或状态未知。已保留当前上下文，不能发送，也不会改成本机执行。</p>}
    {!catalog ? <p className="desktop-remote__muted">{connected ? (error ? '无法读取远端目录，请重新加载。' : '正在读取远端目录…') : '连接后可选择该主机的项目、Provider 和会话。'}</p> : <>
      {connected && !contextAvailable && <p className="desktop-remote__warning" role="status">所选远端项目或 Provider 当前不可用，请重新选择；不会代选其他运行环境。</p>}
      <div className="desktop-remote__workspace-grid">
        <aside className="desktop-remote__sidebar">
          <label>项目<select disabled={Boolean(sessionId)} value={cwd} onChange={(event) => { setCwd(event.target.value); setSessionId(undefined) }}>{cwd && !catalog.projects.some(project => project.path === cwd) && <option value={cwd}>原项目已不可用：{cwd}</option>}{catalog.projects.map((project) => <option key={project.path} value={project.path}>{project.label}</option>)}</select></label>
          <label>Provider<select disabled={Boolean(sessionId)} value={providerSelection} onChange={(event) => { setProviderSelection(event.target.value); setSessionId(undefined) }}>{providerSelection && !provider && <option value={providerSelection}>原 Provider / profile 已不可用</option>}{catalog.providers.map((item) => <option key={desktopProviderKey(item)} value={desktopProviderKey(item)} disabled={!item.available}>{item.label}{item.available ? '' : ' · 不可用'}</option>)}</select></label>
          {provider && <ProviderControls provider={provider} modelId={validModelId} effort={validEffort} permissionMode={validPermissionMode} onModel={setModelId} onEffort={setEffort} onPermission={setPermissionMode} />}
          <label>会话<select value={sessionId ?? ''} onChange={(event) => { const session = contextSessions.find((item) => item.externalSessionId === event.target.value); setSession(session) }}><option value="">新会话</option>{sessionId && !selectedSession && <option value={sessionId}>当前会话 · {sessionId.slice(0, 8)}</option>}{contextSessions.map((session) => <option key={session.sessionId} value={session.externalSessionId}>{session.label}</option>)}</select></label>
          {sessionId && <button type="button" onClick={() => setSession(undefined)}>新建此主机的会话</button>}
          {selectedSession && <p className="desktop-remote__muted">会话归属：{connection.label} · {new Date(selectedSession.ts).toLocaleString()}</p>}
          {contextAvailable && <RemoteFiles api={api} connectionId={connection.id} context={context} />}
        </aside>
        <main className="desktop-remote__transcript" aria-label="远程会话">
          {historyEvidence && <p className="desktop-remote__history-evidence" role="note">历史证据：{historyEvidence.status === 'available' ? '可用' : '不可用'}{historyEvidence.reason ? ` · ${historyEvidence.reason}` : ''}{historyEvidence.hasOlder ? ' · 仍有更早记录未加载' : ''}{historyEvidence.hasOlder && historyEvidence.before !== undefined && <button type="button" disabled={!connected} onClick={() => void loadOlderHistory()}>加载更早记录（每页有上限）</button>}</p>}
          {displayTurns.length === 0 ? <p className="desktop-remote__muted">此上下文暂无会话记录。</p> : displayTurns.map((turn) => <article className="desktop-remote__turn" key={turn.runId}><UserMessage text={turn.userText} /><AssistantTurn turn={turn} selectedId={null} onSelect={() => {}} pendingQuestions={turn.runId === activeRun?.runId ? activeRun.pendingQuestions : []} onAnswerQuestion={answer} remote /></article>)}
          {runStatus && <p className="desktop-remote__run-status" role="status">远程运行：{runStatus.state}{runStatus.detail ? ` · ${runStatus.detail}` : ''}{runStatus.state === 'unknown' ? '（结果未知，不会自动重试）' : ''}</p>}
          <div className="desktop-remote__composer"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !submitting && !(currentIntent && (currentIntent.status === 'unknown' || currentIntent.runId))) { event.preventDefault(); void submit() } }} placeholder="向远程 Agent 提问…" aria-label="远程提示词" /><div><button type="button" onClick={() => void submit()} disabled={!contextAvailable || !prompt.trim() || !providerId || !cwd || submitting || Boolean(currentIntent && (currentIntent.status === 'unknown' || currentIntent.runId))}>发送</button><button type="button" onClick={() => void stop()} disabled={!connected || !currentIntent?.runId}>停止</button></div></div>
        </main>
      </div>
      {intents.filter((intent) => intent.status === 'unknown').map((intent) => <p className="desktop-remote__warning" role="note" key={`unknown:${intent.intentId}`}>提交结果未知；Scry 不会盲目重发同一提示词。<button type="button" disabled={!connected} onClick={() => void checkUnknown(intent)}>检查远端状态</button></p>)}
    </>}
  </div>
}

export function DesktopRemote({ onBack, initialConnectionId }: { onBack: () => void; initialConnectionId?: string }): JSX.Element {
  const { connections, loaded, error: readError } = useDesktopConnections()
  const [selectedId, setSelectedId] = useState<string | null>(initialConnectionId ?? null)
  const effectiveSelectedId = selectedId ?? connections[0]?.id ?? null
  const selectedIdRef = useRef(effectiveSelectedId)
  selectedIdRef.current = effectiveSelectedId
  const [screen, setScreen] = useState<'connections' | 'workspace'>(initialConnectionId ? 'workspace' : 'connections')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = refreshDesktopConnections
  const selected = connections.find(connection => connection.id === effectiveSelectedId)
  const connect = async (): Promise<void> => {
    if (!selected || busy) return
    setError(null); setBusy(true)
    try {
      await bridge().connect(selected.id)
      await refresh()
      if (selectedIdRef.current === selected.id) setScreen('workspace')
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  const finishPairing = async (): Promise<void> => {
    if (!selected || busy) return
    setError(null); setBusy(true)
    try { await bridge().finishPairing(selected.id); await refresh() }
    catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  const disconnect = async (): Promise<void> => {
    if (!selected) return
    try { await bridge().disconnect(selected.id); await refresh() }
    catch (reason) { setError(errorText(reason)) }
  }
  const forget = async (): Promise<void> => {
    if (!selected) return
    try { await bridge().forget(selected.id); await refresh(); setSelectedId(null); setScreen('connections') }
    catch (reason) { setError(errorText(reason)) }
  }
  const workspace = screen === 'workspace' && selected?.state !== 'pairing'
  return <section className="desktop-remote" aria-label="桌面远程连接">
    <header className="desktop-remote__head">
      <button type="button" onClick={onBack}>返回</button>
      <div><h1>{workspace ? '远程会话' : '我连接的主机'}</h1><p>执行、文件和 Provider 凭据留在所选主机，不使用本机运行环境。</p></div>
      {workspace && <button type="button" onClick={() => setScreen('connections')}>管理连接</button>}
    </header>
    {(error || readError) && <p className="desktop-remote__error" role="alert">{error || readError}</p>}
    {!loaded && !readError && <p>正在读取已保存的主机…</p>}
    {!workspace ? <div className="desktop-remote__body">
      <ConnectionList connections={connections} selectedId={effectiveSelectedId} onSelect={setSelectedId} onRefresh={() => void refresh()} error={readError} />
      <div className="desktop-remote__main">
        <ClientPairForm onPaired={async id => { await refresh(); setSelectedId(id) }} />
        {selected && <section className="desktop-remote__card">
          <h2>{selected.label}</h2><p>{selected.ssh.username}@{selected.ssh.hostname}:{selected.ssh.port}</p>
          <p>主机指纹：<code>{selected.anchorSHA256}</code></p>
          <p>状态：{desktopConnectionLabel(selected, readError)}</p>
          <div className="desktop-remote__actions">
            <button type="button" onClick={() => void connect()} disabled={busy || selected.state === 'pairing'}>{selected.state === 'connected' ? '打开远程桌面' : '连接'}</button>
            {selected.state === 'pairing' && <button type="button" onClick={() => void finishPairing()} disabled={busy}>完成配对</button>}
            <button type="button" onClick={() => void disconnect()} disabled={busy || selected.state !== 'connected'}>断开</button>
            <button type="button" onClick={() => void forget()} disabled={busy}>忘记</button>
          </div>
          <p className="desktop-remote__muted">忘记仅移除本地连接，不会撤销该主机上的设备授权。</p>
        </section>}
      </div>
    </div> : selected ? <RemoteWorkspace key={selected.id} connection={selected} connected={selected.state === 'connected' && !readError} onDisconnect={disconnect} onReconnect={connect} /> : loaded && <p role="alert">所选远程连接已不可用。请管理连接；不会改成本机执行。</p>}
  </section>
}

export function RemoteHostPanel(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [invite, setInvite] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    try {
      const status = await window.scry.remoteDesktopHostStatus()
      setEnabled(status.enabled)
      if (!status.enabled && status.reason) setError(status.reason)
    } catch (reason) { setError(errorText(reason)) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const run = async (action: () => Promise<void>): Promise<void> => { setBusy(true); setError(null); try { await action(); await refresh() } catch (reason) { setError(errorText(reason)) } finally { setBusy(false) } }
  if (enabled === null) return error ? <p role="alert">{error}</p> : <p>加载远程桌面主机状态…</p>
  return <section className="desktop-remote__host">
    <div className="desktop-remote__section-head"><b>通过 SSH 访问本机</b><span>{enabled ? '已启用' : '未启用'}</span></div>
    <p className="desktop-remote__muted">SSH 认证不能替代本机配对批准。生成新邀请会使旧的未完成邀请失效。</p>
    {error && <p className="desktop-remote__error" role="alert">{error}</p>}
    <button type="button" onClick={() => void run(async () => setInvite(await window.scry.remoteDesktopHostInvite()))} disabled={busy}>{enabled ? '生成 SSH 邀请' : '启用并生成 SSH 邀请'}</button>
    {enabled && invite && <div className="desktop-remote__invite"><code>{invite}</code><p>邀请包含短时 secret；请仅交给预期的 Scry 桌面客户端。</p></div>}
    {enabled && <button type="button" onClick={() => void run(async () => { await window.scry.remoteDesktopHostDisable(); setInvite(null) })} disabled={busy}>关闭桌面远程主机</button>}
  </section>
}
