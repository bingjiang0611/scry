import { useCallback, useEffect, useState } from 'react'
import type { RemotePairingCode } from '../../shared/remote'
import { projectRemote, confirmArguments, type PendingRow, type RemotePairingViewModel } from '../remote-pairing'

// Trusted-LOCAL remote-access pairing screen (Mac's own renderer only). It drives
// the narrow window.scry.remote* bridge and renders the honest projection: it
// never shows a device as paired until the host confirms a grant, always shows
// the fingerprint the operator must compare against the phone, and surfaces
// disabled/dormant/revoked as real states. It holds no secret beyond the
// short-lived pairing code the host returns for display.
export function RemotePairing(): JSX.Element {
  const [vm, setVm] = useState<RemotePairingViewModel | null>(null)
  const [code, setCode] = useState<RemotePairingCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try { setVm(projectRemote(await window.scry.remoteStatus())) }
    catch (e) { setError(String((e as Error)?.message ?? e)) }
  }, [])

  useEffect(() => {
    void refresh()
    // Poll while enabled so a device that just proved possession appears without
    // a manual refresh. This is display polling only; it changes no host state.
    const timer = setInterval(() => { void refresh() }, 2000)
    return () => clearInterval(timer)
  }, [refresh])

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await action(); await refresh() }
    catch (e) { setError(String((e as Error)?.message ?? e)) }
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

  if (vm === null) return <section className="remote-pairing"><p>加载中…</p></section>
  if (vm.kind === 'disabled') {
    return (
      <section className="remote-pairing">
        <h2>远程访问</h2>
        <p className="remote-pairing__disabled">远程访问未启用（SCRY_REMOTE_HOST 未设置）。</p>
      </section>
    )
  }

  return (
    <section className="remote-pairing">
      <h2>远程访问</h2>
      <p className={vm.relayReady ? 'remote-pairing__relay' : 'remote-pairing__relay remote-pairing__relay--dormant'}>{vm.relayHint}</p>
      {error && <p className="remote-pairing__error" role="alert">{error}</p>}

      <div className="remote-pairing__actions">
        <button type="button" onClick={beginPairing} disabled={busy}>生成配对码</button>
      </div>
      {code && (
        <div className="remote-pairing__code">
          {code.deviceCode ? (
            <>
              <p>用手机扫描此配对码（约 2 分钟内有效）：</p>
              <code className="remote-pairing__devicecode">{code.deviceCode}</code>
            </>
          ) : (
            // No relay dialed yet: there is nothing for the phone to reach, so we
            // only show the one-time secret and say so plainly rather than
            // implying the device can connect.
            <>
              <p>尚未连接中继，手机暂时无法接入。一次性配对口令（约 2 分钟内有效）：</p>
              <code>{code.secret}</code>
            </>
          )}
          <p className="remote-pairing__anchor">主机指纹 {code.anchorSHA256.slice(0, 16).toUpperCase()}…</p>
        </div>
      )}

      <h3>等待确认的设备</h3>
      {vm.pending.length === 0 ? <p className="remote-pairing__empty">暂无</p> : (
        <ul className="remote-pairing__pending">
          {vm.pending.map((row) => (
            <li key={row.pairingId}>
              <span className="remote-pairing__label">{row.label}</span>
              <span className="remote-pairing__status">{row.statusText}</span>
              {row.confirmable && row.fingerprintShort && (
                <span className="remote-pairing__fp">指纹 {row.fingerprintShort}…（请与手机上显示的一致）</span>
              )}
              {row.confirmable
                ? <button type="button" onClick={() => confirm(row)} disabled={busy}>确认</button>
                : null}
              <button type="button" onClick={() => cancel(row.pairingId)} disabled={busy}>取消</button>
            </li>
          ))}
        </ul>
      )}

      <h3>已配对设备</h3>
      {vm.devices.length === 0 ? <p className="remote-pairing__empty">暂无</p> : (
        <ul className="remote-pairing__devices">
          {vm.devices.map((d) => (
            <li key={d.deviceId} className={d.revoked ? 'remote-pairing__device--revoked' : undefined}>
              <span className="remote-pairing__label">{d.label}</span>
              <span className="remote-pairing__status">{d.statusText}</span>
              {!d.revoked && <button type="button" onClick={() => revoke(d.deviceId)} disabled={busy}>吊销</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
