import { useCallback, useEffect, useId, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { RemotePairingCode } from '../../shared/remote'
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'
import { projectRemote, confirmArguments, type PendingRow, type RemotePairingViewModel } from '../remote-pairing'
import { RemoteHostPanel } from './DesktopRemote'
import { RemoteConnectionsSettings } from './HostsView'
import { Icon } from './primitives/Icon'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { ModalFrame } from './Modals'
import { useVisibilityPolling } from '../hooks/useVisibilityPolling'

// Draw the scannable scry1: device code as a QR onto a canvas (CSP-safe: no
// data: URL, no innerHTML). The QR encodes only what the code already contains.
function DeviceCodeQR({ code }: { code: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    QRCode.toCanvas(canvas, code, { margin: 2, width: 240, errorCorrectionLevel: 'M' })
      .then(() => { if (!cancelled) setFailed(false) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [code])
  return (
    <div className="remote-pairing__qr">
      <canvas ref={canvasRef} width={240} height={240} aria-label={copy.pairingQr} />
      {failed && <p className="remote-pairing__error" role="alert">{copy.qrFailed}</p>}
    </div>
  )
}

// Trusted-local remote access settings. Outbound hosts and inbound grants share
// one tab but remain separate sections because they have different authority.
export function RemotePairing({ onNewSession }: { onNewSession: (connectionId: string, cwd: string) => void }): JSX.Element {
  const titleId = useId()
  const [vm, setVm] = useState<RemotePairingViewModel | null>(null)
  const [code, setCode] = useState<RemotePairingCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const reading = useRef(false)

  const refresh = useCallback(async () => {
    if (reading.current) return
    reading.current = true
    try {
      setVm(projectRemote(await window.scry.remoteStatus()))
      setReadError(null)
    } catch (reason) {
      setVm(null)
      setReadError(String((reason as Error)?.message ?? reason))
    } finally { reading.current = false }
  }, [])

  useVisibilityPolling('remote-pairing', refresh, 2000)

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await action(); await refresh() }
    catch (reason) { setError(String((reason as Error)?.message ?? reason)) }
    finally { setBusy(false) }
  }, [refresh])

  const beginPairing = useCallback(() => run(async () => { setCode(await window.scry.remoteBeginPairing()) }), [run])
  const confirm = useCallback((row: PendingRow) => run(async () => {
    const args = confirmArguments(row)
    await window.scry.remoteConfirmPairing(args.pairingId, args.publicKeySHA256)
    setCode(null)
  }), [run])
  const cancel = useCallback((pairingId: string) => run(() => window.scry.remoteCancelPairing(pairingId)), [run])
  const revoke = useCallback((deviceId: string) => run(() => window.scry.remoteRevokeDevice(deviceId)), [run])

  return (
    <section className="remote-pairing">
      <RemoteConnectionsSettings onNewSession={onNewSession} />
      <section className="remote-access-section remote-access-inbound" aria-label={copy.inboundTitle}>
        <h3>{copy.inboundTitle}</h3>
        <div className="remote-access-grid">
          <RemoteHostPanel />
          <article className="remote-access-card">
            <div className="remote-access-card-head">
              <span className="remote-access-icon"><Icon name="laptop" /></span>
              <b>{copy.phone}</b>
              <span className={`remote-access-status ${vm?.kind === 'enabled' && vm.relayReady ? 'is-ready' : vm?.kind === 'enabled' ? 'is-dormant' : ''}`}>
                {vm === null ? readError ? copy.status.unknown : copy.loadingHosts : vm.kind === 'disabled' ? copy.disabled : vm.relayReady ? copy.relayOnline : copy.relayDormant}
              </span>
            </div>
            {vm?.kind === 'enabled' && !vm.relayReady && <p className="remote-access-card-note">{copy.relayDormantEffect}</p>}
            {vm?.kind === 'enabled' && (
              <div className="remote-access-actions">
                <button type="button" className="hosts-button" onClick={beginPairing} disabled={busy}>{copy.generatePairingCode}</button>
              </div>
            )}
            {code && (
              <ModalFrame labelledBy={titleId} className="hosts-add-modal" onClose={() => setCode(null)}>
                <div className="modal-head"><b id={titleId}>{copy.pairPhone}</b><ModalCloseButton aria-label={copy.closePairing} onClick={() => setCode(null)} /></div>
                <div className="modal-body remote-pairing__code">
                {code.deviceCode ? (
                  <>
                    <p>{copy.scanQr}</p>
                    <DeviceCodeQR code={code.deviceCode} />
                    <details className="remote-pairing__codetext">
                      <summary>{copy.showTextCode}</summary>
                      <code className="remote-pairing__devicecode">{code.deviceCode}</code>
                    </details>
                  </>
                ) : (
                  <>
                    <p>{copy.relayUnavailableSecret}</p>
                    <code>{code.secret}</code>
                  </>
                )}
                <p className="remote-pairing__anchor">{copy.hostFingerprint} {code.anchorSHA256.slice(0, 16).toUpperCase()}…</p>
                <p className="hosts-muted">{copy.pairingFingerprintEffect}</p>
                </div>
              </ModalFrame>
            )}
          </article>
        </div>
        {(readError || error) && <p className="remote-pairing__error" role="alert">{readError || error}</p>}

        {vm?.kind === 'enabled' && vm.pending.length > 0 && (
          <section className="remote-device-section">
            <h4>{copy.pendingDevices}</h4>
            <ul className="remote-pairing__pending">
              {vm.pending.map((row) => (
                <li key={row.pairingId}>
                  <span className="remote-pairing__label">{row.label}</span>
                  <span className="remote-pairing__status">{row.statusText}</span>
                  {row.confirmable && row.fingerprintShort && (
                    <span className="remote-pairing__fp">{copy.pendingFingerprint(row.fingerprintShort)}</span>
                  )}
                  {row.confirmable && <button type="button" onClick={() => confirm(row)} disabled={busy}>{copy.confirm}</button>}
                  <button type="button" onClick={() => cancel(row.pairingId)} disabled={busy}>{copy.cancel}</button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {vm?.kind === 'enabled' && <section className="remote-device-section">
          <h4>{copy.authorizedDevices}</h4>
          {vm.devices.length === 0 ? <p className="remote-pairing__empty">{copy.noAuthorizedDevices}</p> : (
            <ul className="remote-pairing__devices">
              {vm.devices.map((device) => (
                <li key={device.deviceId}>
                  <span className="remote-access-icon"><Icon name="laptop" /></span>
                  <span className="remote-pairing__label">{device.label}</span>
                  <button type="button" onClick={() => revoke(device.deviceId)} disabled={busy}>{copy.revoke}</button>
                </li>
              ))}
            </ul>
          )}
        </section>}
      </section>
    </section>
  )
}
