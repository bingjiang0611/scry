// 执行目标卡片上的资源区（P8 §2「卡片上同时显示这台主机的资源」）。
// 只读一次：页面打开时读，之后由页头刷新按钮再读；没有轮询。
import type { DesktopRemoteConnection } from '@shared/desktop-remote'
import { MACHINES_COPY as copy } from '../constants/machines-copy'
import { formatSampleAge } from '../machines-view-model'
import { latestSnapshot, refreshTargetMetrics, useMachines } from '../hooks/useMachines'
import { MachineMeters } from './MachineMeters'
import { Button } from './primitives/Button'

export function TargetMetrics({ connection }: { connection: DesktopRemoteConnection }): JSX.Element | null {
  const state = useMachines().targets.get(connection.id)
  const now = Date.now()
  if (connection.state !== 'connected') {
    return <p className="machine-target-notice" data-tone="info">{copy.targetOffline}。{copy.targetOfflineDetail}</p>
  }
  // 旧宿主不声明 hostMetrics：写「请升级」，不把能力缺失说成读取失败。
  if (state?.unsupported) {
    return <p className="machine-target-notice" data-tone="info">{copy.targetUnsupported}。{copy.targetUnsupportedDetail}</p>
  }
  if (!state || state.read.status === 'unread' || (state.read.status === 'loading' && !state.read.stale)) {
    return <p className="machine-target-notice" data-tone="info" role="status">{copy.loading}</p>
  }
  const read = state.read
  const snapshot = latestSnapshot(read)
  if (snapshot === null) {
    const detail = read.status === 'failed' ? read.detail : ''
    return (
      <div className="machine-target-notice" data-tone="bad" role="alert">
        <b>{copy.targetFailed(detail)}</b>
        <span>{copy.targetFailedDetail}</span>
        <Button size="sm" onClick={() => void refreshTargetMetrics(connection.id)}>{copy.targetRetry}</Button>
      </div>
    )
  }
  return (
    <div className="machine-target-metrics" data-connection-id={connection.id}>
      <MachineMeters snapshot={snapshot} compact />
      {read.status === 'failed' && (
        <p className="machine-target-notice" data-tone="bad" role="alert">
          <b>{copy.targetFailed(read.detail)}</b>
          <span>{copy.targetFailedDetail}</span>
          <Button size="sm" onClick={() => void refreshTargetMetrics(connection.id)}>{copy.targetRetry}</Button>
        </p>
      )}
      <p className="machine-muted">{copy.sampledAt('')}{formatSampleAge(snapshot.sampledAt, now)} · {
        snapshot.scry.providers === null
          ? copy.providerUnreadable
          : copy.providerProcesses(snapshot.scry.providers.reduce((sum, row) => sum + row.processes, 0))
      }</p>
    </div>
  )
}
