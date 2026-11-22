import { useCallback, useEffect, useRef, useState } from 'react'
import type { BackgroundServiceAction, BackgroundServiceStatus } from '../../shared/background-service'
import {
  describeActionResult,
  describeCliApprovalResult,
  describeLoginStartResult,
  projectBackgroundService,
  type BackgroundServiceNotice
} from '../background-service-view'
import { BACKGROUND_SERVICE_READ_COPY, CLI_APPROVAL_COPY, LOGIN_START_COPY } from '../constants/background-service-copy'
import { EmptyState } from './primitives/EmptyState'
import { DelayedSkeletonRows } from './primitives/Skeleton'
import { ipcErrorMessage } from '../constants/ipc-error-copy'
import { useCopyFeedback } from '../hooks/useCopyFeedback'
import type { RendererPlatform } from '../platform'
import { Button } from './primitives/Button'
import { Notice } from './primitives/Notice'
import './background-service.css'

// Settings «后台服务» (B4-S S0-1, P5-2). The section only shows and asks: every
// confirmation is main's own dialog, action buttons send no argument, and login-start
// sends only a boolean. Read once on open and after each action; there is no polling,
// so opening settings never keeps a daemon busy.

const LABELS: Record<BackgroundServiceAction, string> = {
  restart: '重启后台服务',
  reconnect: '重新连接本机后台服务',
  quit: '退出 Scry 与后台服务'
}

export type BackgroundServiceBusy =
  | BackgroundServiceAction
  | 'reading'
  | 'login-start-enable'
  | 'login-start-disable'
  | 'cli-approval-enable'
  | 'cli-approval-disable'
  | null

export function BackgroundServicePanel({
  status, readError, busy, result, now, platform, onRefresh, onAction, onToggleLoginStart, onToggleCliApproval
}: {
  status: BackgroundServiceStatus | null
  readError: string | null
  busy: BackgroundServiceBusy
  result: BackgroundServiceNotice | null
  now: number
  /** Detected when omitted; only chooses whether the Linux keyring advice is shown. */
  platform?: RendererPlatform
  onRefresh: () => void
  onAction: (action: BackgroundServiceAction) => void
  onToggleLoginStart?: (enabled: boolean) => void
  onToggleCliApproval?: (enabled: boolean) => void
}): JSX.Element {
  const cliPathCopy = useCopyFeedback()
  const view = status ? projectBackgroundService(status, now, platform) : null
  const button = (action: BackgroundServiceAction, primary = false) => (
    <Button
      {...(primary ? { variant: 'primary' as const } : {})}
      {...(action === 'quit' ? { className: 'background-service__quit' } : {})}
      disabled={busy !== null}
      aria-busy={busy === action || undefined}
      onClick={() => onAction(action)}
    >
      {busy === action ? `${LABELS[action]}…` : LABELS[action]}
    </Button>
  )
  const loginStart = view?.loginStart
  const cliApproval = view?.cliApproval
  const togglingOn = busy === 'login-start-enable'
  const togglingOff = busy === 'login-start-disable'
  const cliEnabling = busy === 'cli-approval-enable'
  const cliDisabling = busy === 'cli-approval-disable'
  return (
    <div className="settings-body background-service">
      <div className="settings-copy background-service__head">
        <b>后台服务</b>
        <Button disabled={busy !== null} onClick={onRefresh}>
          {busy === 'reading' ? '读取中…' : '刷新'}
        </Button>
      </div>
      {readError && <EmptyState size="card" picture="alert" title={BACKGROUND_SERVICE_READ_COPY.failed} announcement="alert"
        actions={[{ label: BACKGROUND_SERVICE_READ_COPY.refresh, icon: 'refresh', busy: busy === 'reading',
          disabled: busy !== null && busy !== 'reading', onClick: onRefresh }]} />}
      {!view && !readError && <DelayedSkeletonRows loading rows={3} label={BACKGROUND_SERVICE_READ_COPY.loading} />}
      {view?.notice && (
        <p className={`background-service__notice ${view.notice.tone}`} role={view.notice.tone === 'info' ? undefined : 'status'}>
          {view.notice.text}
        </p>
      )}
      {view?.runtimeNotices.map((item) => (
        <Notice key={item.text} tone={item.tone} role="status">{item.text}</Notice>
      ))}
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
      {loginStart && (
        <div className="background-service__section">
          <div className="background-service__section-head">
            <div className="background-service__section-title">
              <b>{LOGIN_START_COPY.sectionTitle}</b>
              <span className="background-service__muted">{loginStart.stateText}</span>
            </div>
            {loginStart.canToggle && onToggleLoginStart && (
              <button
                type="button"
                className="setting-switch"
                role="switch"
                aria-label={LOGIN_START_COPY.sectionTitle}
                aria-checked={loginStart.enabled}
                aria-busy={togglingOn || togglingOff || undefined}
                disabled={busy !== null}
                onClick={() => onToggleLoginStart(!loginStart.enabled)}
              ><span aria-hidden="true" /></button>
            )}
          </div>
          {loginStart.policyEnv.length > 0 && (
            <div className="background-service__policy">
              <p className="background-service__muted">
                {LOGIN_START_COPY.policySnapshotPrefix}
                {loginStart.policyEnv.map((entry) => `${entry.key}=${entry.value}`).join('，')}
              </p>
              <p className="background-service__muted">{LOGIN_START_COPY.policySnapshotHint}</p>
            </div>
          )}
          {loginStart.notices.map((item) => (
            <Notice key={item.text} tone={item.tone} role={item.tone === 'info' ? undefined : 'status'}>
              {item.text}
            </Notice>
          ))}
        </div>
      )}
      {cliApproval && (
        <div className="background-service__section">
          <div className="background-service__section-head">
            <div className="background-service__section-title">
              <b>{CLI_APPROVAL_COPY.sectionTitle}</b>
              <span className="background-service__muted">{cliApproval.stateText}</span>
            </div>
            {cliApproval.canToggle && onToggleCliApproval && (
              <Button
                variant={cliApproval.enabled ? undefined : 'primary'}
                disabled={busy !== null}
                aria-busy={cliEnabling || cliDisabling || undefined}
                onClick={() => onToggleCliApproval(!cliApproval.enabled)}
              >
                {cliEnabling
                  ? CLI_APPROVAL_COPY.enablingButton
                  : cliDisabling
                    ? CLI_APPROVAL_COPY.disablingButton
                    : cliApproval.enabled
                      ? CLI_APPROVAL_COPY.disableButton
                      : CLI_APPROVAL_COPY.enableButton}
              </Button>
            )}
          </div>
          <p className="background-service__muted">{cliApproval.hint}</p>
          {cliApproval.hostCliPath && (
            <div className="background-service__actions">
              <Button disabled={busy !== null} onClick={() => cliPathCopy.copy(cliApproval.hostCliPath!)}>
                {cliPathCopy.status.state === 'copied' ? CLI_APPROVAL_COPY.copiedPathButton : CLI_APPROVAL_COPY.copyPathButton}
              </Button>
              <span className="background-service__muted">{CLI_APPROVAL_COPY.pathPrefix}{cliApproval.hostCliPath}</span>
            </div>
          )}
          {cliPathCopy.status.state === 'failed' && (
            <Notice tone="bad" role="status">{cliPathCopy.status.reason}</Notice>
          )}
        </div>
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
  const [busy, setBusy] = useState<BackgroundServiceBusy>('reading')
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
      console.error('[Scry] background service status read failed', error)
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

  const toggleLoginStart = useCallback(async (enabled: boolean): Promise<void> => {
    setBusy(enabled ? 'login-start-enable' : 'login-start-disable')
    setResult(null)
    try {
      const outcome = await window.scry.setBackgroundServiceLoginStart(enabled)
      if (mounted.current) setResult(describeLoginStartResult(enabled, outcome))
    } catch (error) {
      if (mounted.current) setResult({ tone: 'bad', text: ipcErrorMessage(error) })
    }
    await read()
    if (mounted.current) setBusy(null)
  }, [read])

  const toggleCliApproval = useCallback(async (enabled: boolean): Promise<void> => {
    setBusy(enabled ? 'cli-approval-enable' : 'cli-approval-disable')
    setResult(null)
    try {
      const outcome = await window.scry.setHostCliApproval(enabled)
      if (mounted.current) setResult(describeCliApprovalResult(enabled, outcome))
    } catch (error) {
      if (mounted.current) setResult({ tone: 'bad', text: ipcErrorMessage(error) })
    }
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
      onToggleLoginStart={(enabled) => { void toggleLoginStart(enabled) }}
      onToggleCliApproval={(enabled) => { void toggleCliApproval(enabled) }}
    />
  )
}
