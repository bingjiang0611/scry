// 主机页：管理“我连接的主机”（出站）与“允许其他设备访问本机”（入站）。两个方向
// 分开呈现，不能合并成一个列表。会话交互不在这里，项目行只预填新会话的执行位置。
import { useId, useRef, useState, type FormEvent } from 'react'
import type { DesktopRemoteConnection, DesktopSshTarget } from '@shared/desktop-remote'
import { desktopConnectionLabel, refreshDesktopConnections, useDesktopConnections } from '../hooks/useDesktopConnections'
import { forgetRemoteCatalog, refreshRemoteCatalog, useRemoteCatalogs } from '../hooks/useRemoteCatalogs'
import { bridge, ClientPairForm } from './DesktopRemote'
import { HostStateDot, hostState } from './LocationPicker'
import { ModalFrame } from './Modals'
import { Icon } from './primitives/Icon'
import { RemotePairing } from './RemotePairing'
import './hosts-view.css'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function HostsView({ onNewSession }: { onNewSession: (connectionId: string, cwd: string) => void }) {
  const { connections, loaded, error: readError } = useDesktopConnections()
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const titleId = useId()
  return (
    <section className="hosts-view" aria-label="主机">
      <header className="hosts-header">
        <div>
          <h1>主机</h1>
          <p>在另一台装有 Scry 的电脑上运行 Agent。执行、文件和 Provider 凭据都留在那台主机。</p>
        </div>
        <button type="button" className="hosts-button is-primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> 添加主机
        </button>
      </header>
      <div className="hosts-body">
        <section className="hosts-section" aria-label="我连接的主机">
          <h2>我连接的主机</h2>
          {readError && (
            <div className="hosts-alert" role="alert">
              <span>无法确认连接状态：{readError}</span>
              <button type="button" className="hosts-button" onClick={() => void refreshDesktopConnections()}>重试读取</button>
            </div>
          )}
          {!loaded && !readError && <p className="hosts-muted">正在读取已保存的主机…</p>}
          {loaded && connections.length === 0 && (
            <div className="hosts-empty">
              <p>还没有添加主机。在另一台电脑的 Scry 设置中生成 SSH 邀请，然后在这里添加。</p>
              <button type="button" className="hosts-button" onClick={() => setAdding(true)}>添加主机</button>
            </div>
          )}
          <ul className="hosts-list">
            {connections.map((connection) => (
              <HostRow
                key={connection.id}
                connection={connection}
                readError={readError}
                expanded={expanded === connection.id}
                onToggle={() => setExpanded((current) => current === connection.id ? null : connection.id)}
                onNewSession={(cwd) => onNewSession(connection.id, cwd)}
              />
            ))}
          </ul>
        </section>
        <section className="hosts-section hosts-inbound" aria-label="允许其他设备访问本机">
          <h2>允许其他设备访问本机</h2>
          <p className="hosts-muted">这是另一个方向：其他设备连接到这台 Mac。与上面的列表互不影响。</p>
          <RemotePairing />
        </section>
      </div>
      {adding && (
        <ModalFrame labelledBy={titleId} className="hosts-add-modal" onClose={() => setAdding(false)}>
          <div className="modal-head">
            <b id={titleId}>添加主机</b>
            <button type="button" className="modal-x" onClick={() => setAdding(false)} aria-label="关闭添加主机"><Icon name="x" /></button>
          </div>
          <div className="modal-body">
            <ClientPairForm onPaired={async (id) => { await refreshDesktopConnections(); setExpanded(id) }} />
          </div>
        </ModalFrame>
      )}
    </section>
  )
}

function HostRow({
  connection,
  readError,
  expanded,
  onToggle,
  onNewSession
}: {
  connection: DesktopRemoteConnection
  readError: string | null
  expanded: boolean
  onToggle: () => void
  onNewSession: (cwd: string) => void
}) {
  const state = hostState(connection, readError)
  const entry = useRemoteCatalogs().get(connection.id)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null)
    try { await action(); await refreshDesktopConnections() }
    catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  const api = bridge()
  const detailsId = useId()
  return (
    <li className={`hosts-row ${expanded ? 'is-expanded' : ''}`} data-connection-id={connection.id}>
      <div className="hosts-row-head">
        <button type="button" className="hosts-row-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={onToggle}>
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />
          <Icon name="server" />
          <span className="hosts-identity">
            <b>{connection.label}</b>
            <code>{connection.ssh.username}@{connection.ssh.hostname}:{connection.ssh.port}</code>
          </span>
        </button>
        <span className="hosts-state" data-state={state}><HostStateDot state={state} />{desktopConnectionLabel(connection, readError)}</span>
        <span className="hosts-row-actions">
          {connection.state === 'disconnected' && (
            <button type="button" className="hosts-button" disabled={busy} onClick={() => void run(async () => {
              await api.connect(connection.id)
              await refreshRemoteCatalog(connection.id)
            })}>连接</button>
          )}
          {connection.state === 'pairing' && (
            <button type="button" className="hosts-button" disabled={busy} onClick={() => void run(async () => { await api.finishPairing(connection.id) })}>完成配对</button>
          )}
          {connection.state === 'connected' && (
            <button type="button" className="hosts-button" disabled={busy} onClick={() => void run(() => api.disconnect(connection.id))}>断开</button>
          )}
        </span>
      </div>
      {error && <p className="hosts-error" role="alert">{error}</p>}
      {expanded && (
        <div className="hosts-row-details" id={detailsId}>
          <div className="hosts-address-summary">
            <dl>
              <dt>主机指纹</dt><dd><code>{connection.anchorSHA256}</code></dd>
            </dl>
            <button type="button" className="hosts-button" disabled={busy} onClick={() => setEditing(true)}>编辑连接地址</button>
          </div>
          <h3>项目</h3>
          {state !== 'connected'
            ? <p className="hosts-muted">{entry?.catalog ? '以下是上次连接时读取的项目；连接后才能新建会话。' : '连接后可查看这台主机上的项目。'}</p>
            : !entry?.catalog && <p className="hosts-muted">{entry?.error ? `无法读取项目：${entry.error}` : '正在读取项目…'}</p>}
          {entry?.catalog && entry.catalog.projects.length === 0 && <p className="hosts-muted">这台主机还没有项目。</p>}
          {entry?.catalog && entry.catalog.projects.length > 0 && (
            <ul className="hosts-projects">
              {entry.catalog.projects.map((project) => (
                <li key={project.path}>
                  <Icon name="folder" />
                  <span className="hosts-identity"><b>{project.label}</b><code>{project.path}</code></span>
                  <button type="button" className="hosts-button" disabled={state !== 'connected'} onClick={() => onNewSession(project.path)}>新建会话</button>
                </li>
              ))}
            </ul>
          )}
          <div className="hosts-forget">
            <button type="button" className="hosts-button is-danger" disabled={busy} onClick={() => void run(async () => {
              await api.forget(connection.id)
              forgetRemoteCatalog(connection.id)
            })}>移除主机</button>
            <span className="hosts-muted">只移除本机保存的连接，不会撤销该主机上的设备授权。</span>
          </div>
        </div>
      )}
      {editing && <HostAddressEditor connection={connection} onClose={() => setEditing(false)} />}
    </li>
  )
}

function HostAddressEditor({ connection, onClose }: { connection: DesktopRemoteConnection; onClose: () => void }) {
  const titleId = useId()
  const noteId = useId()
  const hostnameRef = useRef<HTMLInputElement>(null)
  const [hostname, setHostname] = useState(connection.ssh.hostname)
  const [username, setUsername] = useState(connection.ssh.username)
  const [port, setPort] = useState(String(connection.ssh.port))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ssh: DesktopSshTarget = { hostname: hostname.trim(), username: username.trim(), port: Number(port) }
  const changed = ssh.hostname !== connection.ssh.hostname || ssh.username !== connection.ssh.username || ssh.port !== connection.ssh.port
  const close = (): void => { if (!saving) onClose() }
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (saving || !changed) return
    setSaving(true); setError(null)
    try {
      await bridge().updateSsh(connection.id, ssh)
      await refreshDesktopConnections()
      onClose()
    } catch (reason) {
      setError(`保存失败：${errorText(reason)}`)
      // A failed persistence step may still have closed the old tunnel.
      await refreshDesktopConnections()
    } finally { setSaving(false) }
  }
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={hostnameRef} className="hosts-add-modal" onClose={close}>
      <div className="modal-head">
        <b id={titleId}>编辑连接地址</b>
        <button type="button" className="modal-x" disabled={saving} onClick={close} aria-label="关闭编辑连接地址"><Icon name="x" /></button>
      </div>
      <form className="modal-body desktop-remote__card hosts-address-form" onSubmit={(event) => void save(event)} aria-describedby={noteId} aria-busy={saving}>
        <p><strong>{connection.label}</strong></p>
        <p className="hosts-muted" id={noteId}>保留原配对、主机指纹和会话。保存后断开当前连接，请手动重新连接；不会停止远端任务或自动发送草稿。</p>
        <label>主机名 / IP<input ref={hostnameRef} name="hostname" value={hostname} onChange={(event) => setHostname(event.target.value)} required maxLength={253} autoComplete="off" spellCheck={false} readOnly={saving} /></label>
        <div className="desktop-remote__form-grid">
          <label>SSH 用户名<input name="username" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={253} autoComplete="off" spellCheck={false} readOnly={saving} /></label>
          <label>SSH 端口<input name="port" type="number" value={port} onChange={(event) => setPort(event.target.value)} required min={1} max={65535} readOnly={saving} /></label>
        </div>
        {error && <p className="desktop-remote__error" role="alert">{error}</p>}
        <div className="hosts-address-actions">
          <button type="button" className="hosts-button" disabled={saving} onClick={close}>取消</button>
          <button type="submit" className="hosts-button is-primary" disabled={saving || !changed}>{saving ? '正在保存…' : '保存地址'}</button>
        </div>
      </form>
    </ModalFrame>
  )
}
