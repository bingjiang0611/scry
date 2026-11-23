// 执行目标卡片上的资源区（P8 §2「卡片上同时显示这台主机的资源」）。
// 只读一次：页面打开时读，之后由页头刷新按钮再读；没有轮询。
import type { DesktopRemoteConnection } from '@shared/desktop-remote'
import { MACHINES_COPY as copy } from '../constants/machines-copy'
import { formatSampleAge, targetNotice, type TargetNotice, type TargetNoticeKind } from '../machines-view-model'
import { latestSnapshot, refreshTargetMetrics, useMachines } from '../hooks/useMachines'
import { MachineMeters, ScryUsageLine } from './MachineMeters'
import { Button } from './primitives/Button'

export function TargetMetrics({ connection }: { connection: DesktopRemoteConnection }): JSX.Element | null {
  const state = useMachines().targets.get(connection.id)
  const now = Date.now()
  const retry = <Button size="sm" onClick={() => void refreshTargetMetrics(connection.id)}>{copy.targetRetry}</Button>
  if (connection.state !== 'connected') {
    return <Notice notice={targetNotice({ kind: 'offline' })} />
  }
  // 旧宿主不声明 hostMetrics：写「请升级」，不把能力缺失说成读取失败。
  if (state?.unsupported) return <Notice notice={targetNotice({ kind: 'unsupported' })} />
  if (!state || state.read.status === 'unread' || (state.read.status === 'loading' && !state.read.stale)) {
    return <p className="machine-target-notice" data-tone="info" role="status">{copy.loading}</p>
  }
  const read = state.read
  const snapshot = latestSnapshot(read)
  if (snapshot === null) {
    const kind: TargetNoticeKind = read.status === 'failed' ? { kind: 'failed', detail: read.detail } : { kind: 'silent' }
    return <Notice notice={targetNotice(kind)} action={retry} />
  }
  return (
    <div className="machine-target-metrics" data-connection-id={connection.id}>
      <MachineMeters snapshot={snapshot} compact />
      {/* P8 §2：每张机器卡片都有一行「Scry 占用」，执行目标也不例外。 */}
      <ScryUsageLine snapshot={snapshot} />
      <p className="machine-muted">{formatSampleAge(snapshot.sampledAt, now)}</p>
      {read.status === 'failed' && (
        <div className="machine-target-notice" data-tone="bad" role="alert">
          <b>{targetNotice({ kind: 'failed', detail: read.detail })?.title}</b>
          <span>{copy.targetFailedDetail}</span>
          {retry}
        </div>
      )}
    </div>
  )
}

function Notice({ notice, action }: { notice: TargetNotice | null; action?: JSX.Element }): JSX.Element | null {
  if (notice === null) return null
  return (
    <div className="machine-target-notice" data-tone={notice.tone === 'bad' ? 'bad' : 'info'} role={notice.tone === 'bad' ? 'alert' : undefined}>
      <b>{notice.title}</b>
      <span>{notice.detail}</span>
      {action}
    </div>
  )
}
