// Remote building blocks shared by the hosts page and remote conversations.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TraceEvent } from '@shared/trace'
import type { Turn } from '../format'
import type {
  DesktopPairingResult,
  DesktopRemoteAPI,
  DesktopRemoteContext,
  DesktopRemoteIntent,
  RemoteControlOption,
  RemoteProviderRef
} from '@shared/desktop-remote'
import type { WorkspaceEntry, WorkspaceFilePage } from '@shared/workspace'
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

export function historyTurns(history: { turns: Array<{ runId?: string; providerTurnId?: string; forkTurnId?: string; userText: string; attachments?: Turn['attachments']; items: TraceEvent[]; done?: boolean; error?: string; errorHint?: string }> }): Turn[] {
  return history.turns.map((turn, index) => ({ ...turn, runId: turn.runId ?? `remote-turn-${index}`, done: turn.done ?? true }))
}

// The preload object is inferred loosely; the shared contract is the typed surface.
export function bridge(): DesktopRemoteAPI {
  return (window.scry as unknown as { desktopRemote: DesktopRemoteAPI }).desktopRemote
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function defaultOption(options: readonly RemoteControlOption[] | undefined): string | undefined {
  return options?.find((option) => option.isDefault)?.id ?? options?.[0]?.id
}

export function ClientPairForm({ onPaired }: { onPaired: (id: string) => Promise<void> }): JSX.Element {
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

export function RemoteFiles({
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
