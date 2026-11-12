import { useCallback, useEffect, useRef, useState } from 'react'
import type { BackgroundServiceAction, BackgroundServiceStatus } from '../../shared/background-service'
import { describeActionResult, projectBackgroundService, type BackgroundServiceNotice } from '../background-service-view'
import { ipcErrorMessage } from '../constants/ipc-error-copy'
import './background-service.css'

// Settings «后台服务» (B4-S S0-1). The section only shows and asks: every confirmation
// is main's own dialog, and the buttons send no argument. Read once on open and after
// each action; there is no polling, so opening settings never keeps a daemon busy.

const LABELS: Record<BackgroundServiceAction, string> = {
  restart: '重启后台服务',
  reconnect: '重新连接本机后台服务',
  quit: '退出 Scry 与后台服务'
}

export function BackgroundServicePanel({
  status, readError, busy, result, now, onRefresh, onAction
}: {
  status: BackgroundServiceStatus | null
  readError: string | null
  busy: BackgroundServiceAction | 'reading' | null
  result: BackgroundServiceNotice | null
  now: number
  onRefresh: () => void
  onAction: (action: BackgroundServiceAction) => void
}): JSX.Element {
  const view = status ? projectBackgroundService(status, now) : null
  const button = (action: BackgroundServiceAction, primary = false) => (
    <button
      type="button"
      className={`btn ${primary ? 'primary' : ''} ${action === 'quit' ? 'background-service__quit' : ''}`}
      disabled={busy !== null}
      aria-busy={busy === action || undefined}
      onClick={() => onAction(action)}
    >
      {busy === action ? `${LABELS[action]}…` : LABELS[action]}
    </button>
  )
  return (
    <div className="settings-body background-service">
      <div className="settings-copy background-service__head">
        <b>后台服务</b>
        <button type="button" className="btn" disabled={busy !== null} onClick={onRefresh}>
          {busy === 'reading' ? '读取中…' : '刷新'}
        </button>
      </div>
      {readError && <p className="background-service__notice bad" role="alert">读取后台服务状态失败：{readError}</p>}
      {!view && !readError && <p className="background-service__muted">读取中…</p>}
      {view?.notice && (
        <p className={`background-service__notice ${view.notice.tone}`} role={view.notice.tone === 'info' ? undefined : 'status'}>
          {view.notice.text}
        </p>
      )}
      {view && (
        <dl className="background-service__rows">
          {view.rows.map((item) => (
            <div key={item.label} className="background-service__row">
              <dt>{item.label}</dt>
              <dd className={item.unknown ? 'unknown' : undefined}>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {view && (view.actions.restart || view.actions.reconnect || view.actions.quit) && (
        <div className="background-service__actions">
          {view.actions.reconnect && button('reconnect', true)}
          {view.actions.restart && button('restart', view.actions.restartPrimary)}
          {view.actions.quit && button('quit')}
        </div>
      )}
      {view?.actions.quit && (
        <p className="background-service__muted">普通的退出 Scry 不会停止后台服务；它会继续为已配对设备和运行中的任务服务。</p>
      )}
      {result && <p className={`background-service__notice ${result.tone}`} role="status">{result.text}</p>}
    </div>
  )
}

export function BackgroundServiceSettings(): JSX.Element {
  const [status, setStatus] = useState<BackgroundServiceStatus | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<BackgroundServiceAction | 'reading' | null>('reading')
  const [result, setResult] = useState<BackgroundServiceNotice | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const read = useCallback(async (): Promise<void> => {
    try {
      const next = await window.scry.backgroundServiceStatus()
      if (!mounted.current) return
      setStatus(next)
      setReadError(null)
    } catch (error) {
      if (!mounted.current) return
      setStatus(null)
      setReadError(ipcErrorMessage(error))
    }
  }, [])
  const refresh = useCallback(async (): Promise<void> => {
    setBusy('reading')
    try { await read() } finally { if (mounted.current) setBusy(null) }
  }, [read])
  useEffect(() => { void refresh() }, [refresh])

  const act = useCallback(async (action: BackgroundServiceAction): Promise<void> => {
    setBusy(action)
    setResult(null)
    try {
      const outcome = action === 'restart' ? await window.scry.restartBackgroundService()
        : action === 'reconnect' ? await window.scry.reconnectBackgroundService()
          : await window.scry.quitWithBackgroundService()
      if (mounted.current) setResult(describeActionResult(action, outcome))
    } catch (error) {
      if (mounted.current) setResult({ tone: 'bad', text: ipcErrorMessage(error) })
    }
    // Whatever happened, show the state it left behind.
    await read()
    if (mounted.current) setBusy(null)
  }, [read])

  return (
    <BackgroundServicePanel
      status={status}
      readError={readError}
      busy={busy}
      result={result}
      now={Date.now()}
      onRefresh={() => { void refresh() }}
      onAction={(action) => { void act(action) }}
    />
  )
}
