// 机器页（P8 §2）：本机、执行目标、已配对的设备。
// 三块内容都复用原来的组件；这个文件只负责页面骨架、一次性读取和本机卡片。
import { useEffect, useId, useState } from 'react'
import type { HostMetricsSnapshot } from '@shared/host-metrics'
import { MACHINES_COPY as copy } from '../constants/machines-copy'
import { formatSampleAge, hostSummary, runsText } from '../machines-view-model'
import { ensureMachinesRead, latestSnapshot, refreshMachines, useMachines } from '../hooks/useMachines'
import { useDesktopConnections } from '../hooks/useDesktopConnections'
import { MachineDiskList, MachineFacts, MachineMeters, MachineSampleLine, ScryUsageLine, ScryUsageTable } from './MachineMeters'
import { RemoteConnectionsSettings } from './HostsView'
import { InboundDevices } from './RemotePairing'
import { BackgroundServiceSettings } from './BackgroundServiceSettings'
import { RemoteHostPanel } from './DesktopRemote'
import { Icon } from './primitives/Icon'
import { Button } from './primitives/Button'
import { EmptyState } from './primitives/EmptyState'
import { Notice } from './primitives/Notice'
import './machines-view.css'

export function MachinesView({ onNewSession }: { onNewSession: (connectionId: string, cwd: string) => void }): JSX.Element {
  const machines = useMachines()
  const connections = useDesktopConnections()
  const ids = connections.connections.map((connection) => connection.id).join(',')
  useEffect(() => { ensureMachinesRead(ids ? ids.split(',') : []) }, [ids])
  const now = Date.now()
  return (
    <section className="machines-page" aria-label={copy.title}>
      <header className="machines-head">
        <div className="machines-head-text">
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        <div className="machines-head-actions">
          {machines.updatedAt !== null && <span className="machine-sample">{formatSampleAge(machines.updatedAt, now)}</span>}
          <Button onClick={() => { void refreshMachines(ids ? ids.split(',') : []) }}
            aria-busy={machines.refreshing} disabled={machines.refreshing}>
            <Icon name="refresh" /> {machines.refreshing ? copy.refreshing : copy.refresh}
          </Button>
        </div>
      </header>

      <section className="machines-section" aria-label={copy.section.local}>
        <h2>{copy.section.local}</h2>
        <LocalMachineCard />
      </section>

      <section className="machines-section" aria-label={copy.section.targets}>
        <RemoteConnectionsSettings onNewSession={onNewSession} heading={copy.section.targets} showSectionTitle={false} />
      </section>

      <section className="machines-section" aria-label={copy.section.devices}>
        <h2>{copy.section.devices}</h2>
        <InboundDevices />
      </section>
    </section>
  )
}

function LocalMachineCard(): JSX.Element {
  const read = useMachines().local
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const snapshot: HostMetricsSnapshot | null = latestSnapshot(read)
  const now = Date.now()
  const refresh = (): void => { void refreshMachines([]) }
  return (
    <article className="machine-card machine-card--local">
      <div className="machine-card-head">
        <span className="machine-card-icon"><Icon name="server" /></span>
        <span className="machine-card-title">
          <b>{copy.localTitle}</b>
          <span className="machine-card-meta">
            {snapshot ? hostSummary(snapshot) : read.status === 'failed' ? read.detail : copy.loading}
          </span>
        </span>
        <span className="machine-card-state" data-state={read.status}>
          {read.status === 'ready' ? copy.online : read.status === 'failed' ? copy.readFailed : copy.loading}
        </span>
        <button type="button" className="machine-card-expand" aria-expanded={expanded} aria-controls={detailsId}
          onClick={() => setExpanded((current) => !current)}>
          {expanded ? copy.collapseDetail : copy.expandDetail}
          <Icon name={expanded ? 'chevronUp' : 'chevronDown'} />
        </button>
      </div>
      {snapshot === null
        ? read.status === 'failed' && (
          <EmptyState size="card" picture="alert" title={copy.readFailed} announcement="alert"
            actions={[{ label: copy.refresh, icon: 'refresh', onClick: refresh }]} />
        )
        : (
          <>
            <MachineMeters snapshot={snapshot} />
            <ScryUsageLine snapshot={snapshot} />
            <p className="machine-muted"><MachineSampleLine sampledAt={snapshot.sampledAt} now={now} /></p>
            {read.status === 'failed' && (
              <Notice tone="bad" role="alert" action={<Button size="sm" onClick={refresh}>{copy.targetRetry}</Button>}>
                {copy.targetFailed(read.detail)}
              </Notice>
            )}
          </>
        )}
      {expanded && (
        <div className="machine-details" id={detailsId}>
          {snapshot && (
            <>
              <div className="machine-detail-head">
                <h3>{copy.resources}</h3>
                <MachineSampleLine sampledAt={snapshot.sampledAt} now={now} />
              </div>
              <MachineFacts snapshot={snapshot} />
              <h3>{copy.disks}</h3>
              <MachineDiskList snapshot={snapshot} />
              <h3>{copy.scryUsage}</h3>
              <ScryUsageTable snapshot={snapshot} />
              <p className="machine-muted">{copy.runsRow}：{runsText(snapshot.runs)}</p>
            </>
          )}
          <h3>{copy.services}</h3>
          <div className="machine-services">
            <RemoteHostPanel />
            <BackgroundServiceSettings />
          </div>
        </div>
      )}
    </article>
  )
}
