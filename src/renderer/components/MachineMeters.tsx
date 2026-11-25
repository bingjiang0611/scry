// 机器卡片的纯展示层：条、Scry 占用行、明细表。没有数据读取，也没有 IPC。
import type { HostMetricsSnapshot } from '@shared/host-metrics'
import { MACHINES_COPY as copy } from '../constants/machines-copy'
import {
  formatBytes, formatPercent, formatSampleAge, formatSampleTime, memoryPressureText,
  dispatchDiskRole, meterViews, providerName, providerUsageRows, providerUsageTotals, runsText, scryUsageTotals,
  type MeterView
} from '../machines-view-model'
import { Icon } from './primitives/Icon'

export function MachineMeters({ snapshot, compact = false }: { snapshot: HostMetricsSnapshot; compact?: boolean }): JSX.Element {
  const meters = meterViews(snapshot)
  return (
    <div className={`machine-meters ${compact ? 'is-compact' : ''}`}>
      {meters.map((meter) => <Meter key={meter.key} meter={meter} />)}
    </div>
  )
}

function Meter({ meter }: { meter: MeterView }): JSX.Element {
  return (
    <div className="machine-meter" data-meter={meter.key} data-tone={meter.tone}>
      <div className="machine-meter-head">
        <span className="machine-meter-label">{meter.label}</span>
        <span className="machine-meter-value">{meter.valueText}</span>
      </div>
      {meter.percent === null
        ? <span className="machine-meter-track is-unavailable" aria-hidden="true" />
        : (
          <span className="machine-meter-track"
            role="meter" aria-label={meter.label} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.round(meter.percent)} aria-valuetext={meter.valueText}>
            <span className="machine-meter-fill" style={{ width: `${meter.percent}%` }} />
          </span>
        )}
    </div>
  )
}

/** 一行「Scry 占用」：分别显示后台服务和 Provider 进程合计；读不到 Provider 数据时明确提示。 */
export function ScryUsageLine({ snapshot }: { snapshot: HostMetricsSnapshot }): JSX.Element {
  const providers = providerUsageRows(snapshot)
  const totals = providerUsageTotals(snapshot)
  const daemonCpu = formatPercent(snapshot.scry.daemon.cpuPercent)
  return (
    <dl className="machine-usage">
      <dt><Icon name="server" /> {copy.scryUsage}</dt>
      <dd>
        <span>{copy.daemon} <b>{daemonCpu}</b> · {formatBytes(snapshot.scry.daemon.rssBytes)}</span>
        <span>
          {providers === null ? copy.providerUnreadable
            : `${copy.providerProcesses(totals.processes ?? 0)}${totals.cpuPercent === null ? '' : ` · ${formatPercent(totals.cpuPercent)}`} · ${totals.rssBytes === null ? copy.unavailable : formatBytes(totals.rssBytes)}`}
        </span>
      </dd>
    </dl>
  )
}

export function ScryUsageTable({ snapshot }: { snapshot: HostMetricsSnapshot }): JSX.Element {
  const providers = providerUsageRows(snapshot)
  const totals = scryUsageTotals(snapshot)
  return (
    <div className="machine-usage-table">
      <table>
        <thead>
          <tr>
            <th scope="col">{copy.usageTable.source}</th>
            <th scope="col">{copy.usageTable.processes}</th>
            <th scope="col">{copy.usageTable.cpu}</th>
            <th scope="col">{copy.usageTable.memory}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{copy.daemon}</td>
            <td>1</td>
            <td>{formatPercent(snapshot.scry.daemon.cpuPercent)}</td>
            <td>{formatBytes(snapshot.scry.daemon.rssBytes)}</td>
          </tr>
          {providers?.map((row) => (
            <tr key={row.providerId}>
              <td>{providerName(row.providerId)}</td>
              <td>{row.processes}</td>
              <td>{formatPercent(row.cpuPercent)}</td>
              <td>{formatBytes(row.rssBytes)}</td>
            </tr>
          ))}
          <tr className="is-total">
            <td>{copy.usageTable.total}</td>
            <td>{totals.processes === null ? copy.unavailable : totals.processes + 1}</td>
            <td>{formatPercent(totals.cpuPercent)}</td>
            <td>{totals.rssBytes === null ? copy.unavailable : formatBytes(totals.rssBytes)}</td>
          </tr>
        </tbody>
      </table>
      {providers === null
        ? <p className="machine-muted" role="status">{copy.providerUnreadable}</p>
        : <p className="machine-muted">{copy.usageTable.note}</p>}
    </div>
  )
}

export function MachineDiskList({ snapshot }: { snapshot: HostMetricsSnapshot }): JSX.Element {
  return (
    <dl className="machine-disks">
      {snapshot.disks.length === 0 && <dd className="machine-muted">{copy.unavailable}</dd>}
      {snapshot.disks.map((disk) => (
        <div key={disk.role} className="machine-disk">
          <dt>{dispatchDiskRole(disk.role)}</dt>
          <dd>
            <span>剩余 {formatBytes(disk.freeBytes)}</span>
            <span className="machine-muted">共 {formatBytes(disk.totalBytes)}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function MachineFacts({ snapshot }: { snapshot: HostMetricsSnapshot }): JSX.Element {
  return (
    <dl className="machine-facts">
      <div><dt>CPU</dt><dd>{formatPercent(snapshot.cpu.percent)} · {snapshot.cpu.cores} 核</dd></div>
      <div><dt>负载</dt><dd>{snapshot.cpu.load1 === null ? copy.unavailable : `${snapshot.cpu.load1.toFixed(2)} / ${snapshot.cpu.cores} 核`}</dd></div>
      <div><dt>内存压力</dt><dd>{memoryPressureText(snapshot.memory.pressure)}</dd></div>
      <div><dt>{copy.runsRow}</dt><dd>{runsText(snapshot.runs)}</dd></div>
    </dl>
  )
}

export function MachineSampleLine({ sampledAt, now }: { sampledAt: number; now: number }): JSX.Element {
  return <span className="machine-sample">{copy.sampledAt(formatSampleTime(sampledAt))}{formatSampleAge(sampledAt, now)}</span>
}
