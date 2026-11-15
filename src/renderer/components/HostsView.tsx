// Settings surface for saved outbound desktop connections. Inbound access stays
// in RemotePairing so the two directions remain separate while sharing one tab.
import { useId, useRef, useState, type FormEvent } from 'react'
import type { DesktopRemoteConnection, DesktopSshTarget } from '@shared/desktop-remote'
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'
import { desktopConnectionLabel, refreshDesktopConnections, useDesktopConnections } from '../hooks/useDesktopConnections'
import { forgetRemoteCatalog, refreshRemoteCatalog, useRemoteCatalogs } from '../hooks/useRemoteCatalogs'
import { bridge, ClientPairForm } from './DesktopRemote'
import { HostStateDot, hostState } from './LocationPicker'
import { ModalFrame, requestModalClose } from './Modals'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { BusyLabel } from './primitives/BusyLabel'
import { Icon } from './primitives/Icon'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import './hosts-view.css'
import { Button } from './primitives/Button'
import { Notice } from './primitives/Notice'

function errorText(error: unknown): string {
  return copy.errorText(error)
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
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> {copy.addHost}
        </Button>
      </header>
      <section className="remote-access-section" aria-label={copy.outboundTitle}>
        <h3>{copy.outboundTitle}</h3>
        {readError && (
          <Notice tone="warn" className="hosts-alert" role="alert" action={<Button size="sm" onClick={() => void refreshDesktopConnections()}>{copy.retry}</Button>}>
            {copy.connectionReadError(readError)}
          </Notice>
        )}
        {!loaded && !readError && <p className="hosts-muted">{copy.loadingHosts}</p>}
        {loaded && !readError && connections.length === 0 && (
          <div className="hosts-empty">
            <b>{copy.noHosts}</b>
            <p>{copy.noHostsHint}</p>
            <Button onClick={() => setAdding(true)}>{copy.addHost}</Button>
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
            <ModalCloseButton onClick={() => requestModalClose()} aria-label={copy.closeAddHost} />
          </div>
          <div className="modal-body">
            <ClientPairForm onPaired={async (id) => { await refreshDesktopConnections(); setExpanded(id) }} />
          </div>
        </ModalFrame>
      )}
    </section>
  )
}

type HostAction = 'connect' | 'finishPairing' | 'disconnect' | 'forget'

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
  const [editing, setEditing] = useState(false)
  // SSH round trips take seconds: the pressed button shows it (after the shared delay),
  // a second press is ignored, and a failure stays on this row with a retry.
  const action = useAsyncAction<HostAction>(errorText)
  const busy = action.pending !== null
  const run = (key: HostAction, work: () => Promise<void>): void =>
    action.run(key, async () => { await work(); await refreshDesktopConnections() })
  const pressed = (key: HostAction) => ({
    'aria-busy': action.pending === key,
    'aria-disabled': busy,
    disabled: busy && action.pending !== key
  })
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
            <Button {...pressed('connect')} onClick={() => run('connect', async () => {
              await api.connect(connection.id)
              await refreshRemoteCatalog(connection.id)
            })}><BusyLabel busy={action.showBusy && action.pending === 'connect'}>{copy.connect}</BusyLabel></Button>
          )}
          {connection.state === 'pairing' && (
            <Button {...pressed('finishPairing')} onClick={() => run('finishPairing', async () => { await api.finishPairing(connection.id) })}><BusyLabel busy={action.showBusy && action.pending === 'finishPairing'}>{copy.finishPairing}</BusyLabel></Button>
          )}
          {connection.state === 'connected' && (
            <Button {...pressed('disconnect')} onClick={() => run('disconnect', () => api.disconnect(connection.id))}><BusyLabel busy={action.showBusy && action.pending === 'disconnect'}>{copy.disconnect}</BusyLabel></Button>
          )}
          <button type="button" className="hosts-row-expand" aria-label={copy.hostDetails(expanded, connection.label)} onClick={onToggle}>
            <Icon name={expanded ? 'chevronUp' : 'chevronDown'} />
          </button>
        </span>
      </div>
      {action.error && (
        <Notice tone="bad" className="hosts-error" role="alert" action={<Button size="sm" onClick={action.retry}>{copy.retry}</Button>}>
          {action.error.text}
        </Notice>
      )}
      {expanded && (
        <div className="hosts-row-details" id={detailsId}>
          <div className="hosts-address-summary">
            <dl>
              <dt>{copy.hostFingerprint}</dt><dd><code>{connection.anchorSHA256}</code></dd>
            </dl>
            <Button disabled={busy} onClick={() => setEditing(true)}><Icon name="edit" /> {copy.editAddress}</Button>
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
                  <Button disabled={state !== 'connected'} onClick={() => onNewSession(project.path)}>{copy.newSession}</Button>
                </li>
              ))}
            </ul>
          )}
          <div className="hosts-forget">
            <Button variant="danger" {...pressed('forget')} onClick={() => run('forget', async () => {
              await api.forget(connection.id)
              forgetRemoteCatalog(connection.id)
            })}><BusyLabel busy={action.showBusy && action.pending === 'forget'}>{copy.removeHost}</BusyLabel></Button>
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
    <ModalFrame labelledBy={titleId} initialFocusRef={hostnameRef} className="hosts-add-modal" closeDisabled={saving} onClose={close}>
      <div className="modal-head">
        <b id={titleId}>{copy.editAddress}</b>
        <ModalCloseButton disabled={saving} onClick={() => requestModalClose()} aria-label={copy.closeEditAddress} />
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
          <Button disabled={saving} onClick={() => requestModalClose()}>{copy.cancel}</Button>
          <Button variant="primary" type="submit" disabled={saving || !changed}>{saving ? copy.saving : copy.saveAddress}</Button>
        </div>
      </form>
    </ModalFrame>
  )
}
