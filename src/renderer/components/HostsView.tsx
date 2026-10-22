// Settings surface for saved outbound desktop connections. Inbound access stays
// in RemotePairing so the two directions remain separate while sharing one tab.
import { useId, useRef, useState, type FormEvent } from 'react'
import type { DesktopRemoteConnection, DesktopSshTarget } from '@shared/desktop-remote'
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'
import { desktopConnectionLabel, refreshDesktopConnections, useDesktopConnections } from '../hooks/useDesktopConnections'
import { forgetRemoteCatalog, refreshRemoteCatalog, useRemoteCatalogs } from '../hooks/useRemoteCatalogs'
import { bridge, ClientPairForm } from './DesktopRemote'
import { HostStateDot, hostState } from './LocationPicker'
import { ModalFrame } from './Modals'
import { Icon } from './primitives/Icon'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import './hosts-view.css'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function RemoteConnectionsSettings({ onNewSession }: { onNewSession: (connectionId: string, cwd: string) => void }) {
  const { connections, loaded, refreshing, error: readError } = useDesktopConnections()
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const titleId = useId()
  return (
    <section className="remote-connections-settings" aria-label={copy.outboundTitle}>
      <header className="remote-access-header">
        <h2>{copy.title}</h2>
        <button type="button" className="hosts-button is-primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> {copy.addHost}
        </button>
      </header>
      <section className="remote-access-section" aria-label={copy.outboundTitle}>
        <h3>{copy.outboundTitle}</h3>
        {readError && (
          <div className="hosts-alert" role="alert">
            <span>{copy.connectionReadError(readError)}</span>
            <button type="button" className="hosts-button" onClick={() => void refreshDesktopConnections()}>{copy.retry}</button>
          </div>
        )}
        {!loaded && !readError && <p className="hosts-muted">{copy.loadingHosts}</p>}
        {loaded && !readError && connections.length === 0 && (
          <div className="hosts-empty">
            <b>{copy.noHosts}</b>
            <p>{copy.noHostsHint}</p>
            <button type="button" className="hosts-button" onClick={() => setAdding(true)}>{copy.addHost}</button>
          </div>
        )}
        <ul className="hosts-list">
          {connections.map((connection) => (
            <HostRow
              key={connection.id}
              connection={connection}
              readError={readError}
              refreshing={refreshing}
              expanded={expanded === connection.id}
              onToggle={() => setExpanded((current) => current === connection.id ? null : connection.id)}
              onNewSession={(cwd) => onNewSession(connection.id, cwd)}
            />
          ))}
        </ul>
      </section>
      {adding && (
        <ModalFrame labelledBy={titleId} className="hosts-add-modal" onClose={() => setAdding(false)}>
          <div className="modal-head">
            <b id={titleId}>{copy.addHost}</b>
            <ModalCloseButton onClick={() => setAdding(false)} aria-label={copy.closeAddHost} />
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
  refreshing,
  expanded,
  onToggle,
  onNewSession
}: {
  connection: DesktopRemoteConnection
  readError: string | null
  refreshing: boolean
  expanded: boolean
  onToggle: () => void
  onNewSession: (cwd: string) => void
}) {
  const state = hostState(connection, readError, refreshing)
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
          <Icon name="server" />
          <span className="hosts-identity">
            <b>{connection.label}</b>
            <code>{connection.ssh.username}@{connection.ssh.hostname}:{connection.ssh.port}</code>
          </span>
        </button>
        <span className="hosts-state" data-state={state}><HostStateDot state={state} />{desktopConnectionLabel(connection, readError, refreshing)}</span>
        <span className="hosts-row-actions">
          {connection.state === 'disconnected' && (
            <button type="button" className="hosts-button" disabled={busy} onClick={() => void run(async () => {
              await api.connect(connection.id)
              await refreshRemoteCatalog(connection.id)
            })}>{copy.connect}</button>
          )}
          {connection.state === 'pairing' && (
            <button type="button" className="hosts-button" disabled={busy} onClick={() => void run(async () => { await api.finishPairing(connection.id) })}>{copy.finishPairing}</button>
          )}
          {connection.state === 'connected' && (
            <button type="button" className="hosts-button" disabled={busy} onClick={() => void run(() => api.disconnect(connection.id))}>{copy.disconnect}</button>
          )}
          <button type="button" className="hosts-row-expand" aria-label={copy.hostDetails(expanded, connection.label)} onClick={onToggle}>
            <Icon name={expanded ? 'chevronUp' : 'chevronDown'} />
          </button>
        </span>
      </div>
      {error && <p className="hosts-error" role="alert">{error}</p>}
      {expanded && (
        <div className="hosts-row-details" id={detailsId}>
          <div className="hosts-address-summary">
            <dl>
              <dt>{copy.hostFingerprint}</dt><dd><code>{connection.anchorSHA256}</code></dd>
            </dl>
            <button type="button" className="hosts-button" disabled={busy} onClick={() => setEditing(true)}><Icon name="edit" /> {copy.editAddress}</button>
          </div>
          <h4>{copy.projects}</h4>
          {state !== 'connected'
            ? <p className="hosts-muted">{entry?.catalog ? copy.cachedProjects : copy.connectForProjects}</p>
            : !entry?.catalog && <p className="hosts-muted">{entry?.error ? copy.projectReadError(entry.error) : copy.loadingProjects}</p>}
          {entry?.catalog && entry.catalog.projects.length === 0 && <p className="hosts-muted">{copy.noProjects}</p>}
          {entry?.catalog && entry.catalog.projects.length > 0 && (
            <ul className="hosts-projects">
              {entry.catalog.projects.map((project) => (
                <li key={project.path}>
                  <Icon name="folder" />
                  <span className="hosts-identity"><b>{project.label}</b><code>{project.path}</code></span>
                  <button type="button" className="hosts-button" disabled={state !== 'connected'} onClick={() => onNewSession(project.path)}>{copy.newSession}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="hosts-forget">
            <button type="button" className="hosts-button is-danger" disabled={busy} onClick={() => void run(async () => {
              await api.forget(connection.id)
              forgetRemoteCatalog(connection.id)
            })}>{copy.removeHost}</button>
            <span className="hosts-muted">{copy.removeHostEffect}</span>
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
      setError(copy.saveFailed(errorText(reason)))
      // A failed persistence step may still have closed the old tunnel.
      await refreshDesktopConnections()
    } finally { setSaving(false) }
  }
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={hostnameRef} className="hosts-add-modal" onClose={close}>
      <div className="modal-head">
        <b id={titleId}>{copy.editAddress}</b>
        <ModalCloseButton disabled={saving} onClick={close} aria-label={copy.closeEditAddress} />
      </div>
      <form className="modal-body desktop-remote__card hosts-address-form" onSubmit={(event) => void save(event)} aria-describedby={noteId} aria-busy={saving}>
        <p><strong>{connection.label}</strong></p>
        <p className="hosts-muted" id={noteId}>{copy.editAddressEffect}</p>
        <label>{copy.hostname}<input ref={hostnameRef} name="hostname" value={hostname} onChange={(event) => setHostname(event.target.value)} required maxLength={253} autoComplete="off" spellCheck={false} readOnly={saving} /></label>
        <div className="desktop-remote__form-grid">
          <label>{copy.sshUsername}<input name="username" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={253} autoComplete="off" spellCheck={false} readOnly={saving} /></label>
          <label>{copy.sshPort}<input name="port" type="number" value={port} onChange={(event) => setPort(event.target.value)} required min={1} max={65535} readOnly={saving} /></label>
        </div>
        {error && <p className="desktop-remote__error" role="alert">{error}</p>}
        <div className="hosts-address-actions">
          <button type="button" className="hosts-button" disabled={saving} onClick={close}>{copy.cancel}</button>
          <button type="submit" className="hosts-button is-primary" disabled={saving || !changed}>{saving ? copy.saving : copy.saveAddress}</button>
        </div>
      </form>
    </ModalFrame>
  )
}
