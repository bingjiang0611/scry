import { useCopyFeedback } from '../hooks/useCopyFeedback'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { BusyLabel } from './primitives/BusyLabel'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { TraceEvent } from '@shared/trace'
import type { Turn } from '../format'
import type { DesktopPairingResult, DesktopRemoteAPI, DesktopRemoteContext, DesktopRemoteIntent, RemoteControlOption, RemoteProviderRef } from '@shared/desktop-remote'
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'
import { WorkspacePanel, type ReadOnlyWorkspaceSource } from './WorkspacePanel'
import { Icon } from './primitives/Icon'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { ModalFrame, requestModalClose } from './Modals'
import './desktop-remote.css'
import { Button } from './primitives/Button'

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
  return copy.errorText(error)
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
  // An SSH handshake takes seconds: the pressed button shows it after the shared
  // delay, a second press is ignored, and a failure stays here with a retry.
  const action = useAsyncAction<'pair' | 'finish'>(errorText)
  const busy = action.pending !== null
  const pair = (): void => action.run('pair', async () => {
    const result = await bridge().pair({ label: label.trim() || hostname.trim(), ssh: { username: username.trim(), hostname: hostname.trim(), port: Number(port) }, invitation: invitation.trim() })
    setPairing(result); await onPaired(result.connection.id)
  })
  const finish = (): void => {
    if (!pairing) return
    const id = pairing.connection.id
    action.run('finish', async () => { setPairing(await bridge().finishPairing(id)); await onPaired(id) })
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
      {action.error && <p className="desktop-remote__error" role="alert">{action.error.text}
        <Button size="sm" onClick={action.retry}>{copy.retry}</Button></p>}
      {!pairing ? <button type="button" onClick={() => { if (!busy) pair() }} aria-busy={action.pending === 'pair'} aria-disabled={busy}
        disabled={!busy && (!username.trim() || !hostname.trim() || !invitation.trim())}><BusyLabel busy={action.showBusy && action.pending === 'pair'}>{copy.pair}</BusyLabel></button> : (
        <div className="desktop-remote__pairing-result">
          <p><b>{copy.deviceFingerprint}</b></p><code>{pairing.publicKeySHA256}</code>
          <p>{pairing.state === 'pending' ? copy.awaitingHostApproval : copy.devicePaired}</p>
          {pairing.state === 'pending' && <button type="button" onClick={() => { if (!busy) finish() }} aria-busy={action.pending === 'finish'} aria-disabled={busy}>
            <BusyLabel busy={action.showBusy && action.pending === 'finish'}>{copy.finishPairing}</BusyLabel></button>}
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
  const hostAction = useAsyncAction<'invite' | 'disable'>(errorText)
  const busy = hostAction.pending !== null
  // The copied invite is not visible anywhere, so the copy itself is confirmed.
  const inviteCopy = useCopyFeedback()
  const refresh = useCallback(async () => {
    try {
      const status = await window.scry.remoteDesktopHostStatus()
      setEnabled(status.enabled)
      setError(!status.enabled && status.reason ? status.reason : null)
    } catch (reason) { setEnabled(null); setError(errorText(reason)) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const run = (key: 'invite' | 'disable', work: () => Promise<void>): void => hostAction.run(key, async () => { await work(); await refresh() })
  return <article className="remote-access-card desktop-remote__host">
    <div className="remote-access-card-head">
      <span className="remote-access-icon"><Icon name="server" /></span>
      <b>{copy.desktop}</b>
      <span className={`remote-access-status ${enabled ? 'is-ready' : ''}`}>{enabled === null ? error ? copy.status.unknown : copy.loadingDesktopStatus : enabled ? copy.enabled : copy.disabled}</span>
    </div>
    {error && <p className="desktop-remote__error" role="alert">{error}</p>}
    {hostAction.error && <p className="desktop-remote__error" role="alert">{hostAction.error.text}
      <Button size="sm" onClick={hostAction.retry}>{copy.retry}</Button></p>}
    {enabled !== null && <div className="remote-access-actions">
      <Button onClick={() => { if (!busy) run('invite', async () => setInvite(await window.scry.remoteDesktopHostInvite())) }}
        aria-busy={hostAction.pending === 'invite'} aria-disabled={busy} disabled={busy && hostAction.pending !== 'invite'}>
        <BusyLabel busy={hostAction.showBusy && hostAction.pending === 'invite'}>{enabled ? copy.generateSshInvite : copy.enableAndGenerateSshInvite}</BusyLabel></Button>
      {enabled && <Button variant="quiet" onClick={() => { if (!busy) run('disable', async () => { await window.scry.remoteDesktopHostDisable(); setInvite(null) }) }}
        aria-busy={hostAction.pending === 'disable'} aria-disabled={busy} disabled={busy && hostAction.pending !== 'disable'}>
        <BusyLabel busy={hostAction.showBusy && hostAction.pending === 'disable'}>{copy.disableDesktopAccess}</BusyLabel></Button>}
    </div>}
    {enabled && invite && <ModalFrame labelledBy={titleId} className="hosts-add-modal" onClose={() => setInvite(null)}>
      <div className="modal-head"><b id={titleId}>{copy.sshInvite}</b><ModalCloseButton aria-label={copy.closeInvite} onClick={() => requestModalClose()} /></div>
      <div className="modal-body"><p className="hosts-muted">{copy.sshInviteEffect}</p><div className="desktop-remote__invite"><code>{invite}</code></div>
        {error && <p className="desktop-remote__error" role="alert">{error}</p>}
        <div className="hosts-address-actions"><Button onClick={() => requestModalClose()}>{copy.close}</Button><Button variant="primary" onClick={() => inviteCopy.copy(invite)}><Icon name={inviteCopy.status.state === 'copied' ? 'check' : 'copy'} />{copy.copyInvite}</Button></div>
        <p className={inviteCopy.status.state === 'failed' ? 'desktop-remote__error' : 'hosts-muted desktop-remote__copy-status'}
          role={inviteCopy.status.state === 'failed' ? 'alert' : 'status'}>
          {inviteCopy.status.state === 'copied' ? copy.inviteCopied : inviteCopy.status.state === 'failed' ? copy.inviteCopyFailed(inviteCopy.status.reason) : ''}
        </p>
      </div>
    </ModalFrame>}
  </article>
}
