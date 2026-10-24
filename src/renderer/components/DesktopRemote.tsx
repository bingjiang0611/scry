// Remote building blocks shared by the hosts page and remote conversations.
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
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
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'
import { WorkspacePanel, type ReadOnlyWorkspaceSource } from './WorkspacePanel'
import { Icon } from './primitives/Icon'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { ModalFrame, requestModalClose } from './Modals'
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
      <div className="desktop-remote__form-grid">
        <label>{copy.displayName}<input value={label} onChange={(event) => setLabel(event.target.value)} autoComplete="off" /></label>
        <label>{copy.sshUsername}<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label>
        <label>{copy.hostname}<input value={hostname} onChange={(event) => setHostname(event.target.value)} autoComplete="off" required /></label>
        <label>{copy.sshPort}<input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" required /></label>
      </div>
      <label>{copy.invitationString}<textarea value={invitation} onChange={(event) => setInvitation(event.target.value)} rows={4} spellCheck={false} required /></label>
      {error && <p className="desktop-remote__error" role="alert">{error}</p>}
      {!pairing ? <button type="button" onClick={() => void pair()} disabled={busy || !username.trim() || !hostname.trim() || !invitation.trim()}>{copy.pair}</button> : (
        <div className="desktop-remote__pairing-result">
          <p><b>{copy.deviceFingerprint}</b></p><code>{pairing.publicKeySHA256}</code>
          <p>{pairing.state === 'pending' ? copy.awaitingHostApproval : copy.devicePaired}</p>
          {pairing.state === 'pending' && <button type="button" onClick={() => void finish()} disabled={busy}>{copy.finishPairing}</button>}
        </div>
      )}
    </section>
  )
}

export function RemoteFiles({
  api,
  connectionId,
  context,
  onClose
}: {
  api: DesktopRemoteAPI
  connectionId: string
  context: DesktopRemoteContext
  onClose: () => void
}): JSX.Element {
  // Keep remote reads on the authenticated host transport. Never interpret a host
  // path as a local workspace, including when remote preview is unavailable.
  const source = useMemo<ReadOnlyWorkspaceSource>(() => ({
    workspaceList: ({ path = '', cursor }) => api.files(connectionId, context, path, cursor),
    workspaceReadPage: ({ path, offset, snapshot }) => api.file(connectionId, context, path, offset, snapshot)
  }), [api, connectionId, context])
  return <WorkspacePanel cwd={context.cwd} readOnlySource={source} onClose={onClose} onAddReference={() => {}} />
}

export function RemoteHostPanel(): JSX.Element {
  const titleId = useId()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [invite, setInvite] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    try {
      const status = await window.scry.remoteDesktopHostStatus()
      setEnabled(status.enabled)
      setError(!status.enabled && status.reason ? status.reason : null)
    } catch (reason) { setEnabled(null); setError(errorText(reason)) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const run = async (action: () => Promise<void>): Promise<void> => { setBusy(true); setError(null); try { await action(); await refresh() } catch (reason) { setError(errorText(reason)) } finally { setBusy(false) } }
  return <article className="remote-access-card desktop-remote__host">
    <div className="remote-access-card-head">
      <span className="remote-access-icon"><Icon name="server" /></span>
      <b>{copy.desktop}</b>
      <span className={`remote-access-status ${enabled ? 'is-ready' : ''}`}>{enabled === null ? error ? copy.status.unknown : copy.loadingDesktopStatus : enabled ? copy.enabled : copy.disabled}</span>
    </div>
    {error && <p className="desktop-remote__error" role="alert">{error}</p>}
    {enabled !== null && <div className="remote-access-actions">
      <button type="button" className="hosts-button" onClick={() => void run(async () => setInvite(await window.scry.remoteDesktopHostInvite()))} disabled={busy}>{enabled ? copy.generateSshInvite : copy.enableAndGenerateSshInvite}</button>
      {enabled && <button type="button" className="hosts-button is-quiet" onClick={() => void run(async () => { await window.scry.remoteDesktopHostDisable(); setInvite(null) })} disabled={busy}>{copy.disableDesktopAccess}</button>}
    </div>}
    {enabled && invite && <ModalFrame labelledBy={titleId} className="hosts-add-modal" onClose={() => setInvite(null)}>
      <div className="modal-head"><b id={titleId}>{copy.sshInvite}</b><ModalCloseButton aria-label={copy.closeInvite} onClick={() => requestModalClose()} /></div>
      <div className="modal-body"><p className="hosts-muted">{copy.sshInviteEffect}</p><div className="desktop-remote__invite"><code>{invite}</code></div>
        {error && <p className="desktop-remote__error" role="alert">{error}</p>}
        <div className="hosts-address-actions"><button type="button" className="hosts-button" onClick={() => requestModalClose()}>{copy.close}</button><button type="button" className="hosts-button is-primary" onClick={() => { void window.scry.copyText(invite).catch(reason => setError(errorText(reason))) }}><Icon name="copy" />{copy.copyInvite}</button></div>
      </div>
    </ModalFrame>}
  </article>
}
