import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { ProjectMeta } from '../env'


import { Icon } from './primitives/Icon'
import { Tabs } from './primitives/Tabs'
import { Segmented } from './primitives/Segmented'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { MODAL_COPY } from '../constants/copy'


import { ArchivedRemoteChatsPanel } from './ArchivedRemoteChatsPanel'
import { useRemoteProjectGroups } from './SidebarRemoteProjects'
import { useDesktopConnections } from '../hooks/useDesktopConnections'
import { useRemoteCatalogs } from '../hooks/useRemoteCatalogs'
import './archived-sessions.css'
import { REMOTE_ACCESS_COPY as remoteCopy } from '../constants/copy'
import { MACHINES_COPY } from '../constants/machines-copy'
import { Button } from './primitives/Button'
import type { AppTheme } from '../theme'
import { ModalFrame, requestModalClose } from './ModalFrame'
import { ArchivedChatsPanel } from './ArchivedChatsPanel'
import { BackgroundServiceSettings } from './BackgroundServiceSettings'

export type SettingsTab = 'appearance' | 'archived' | 'remote' | 'service'

type ArchivedIndexState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'available'; projects: ProjectMeta[] }

export function SettingsModal({
  theme,
  onThemeChange,
  onClose,
  onSessionsChanged,
  onOpenMachines,
  initialTab = 'appearance'
}: {
  theme: AppTheme
  onThemeChange: (theme: AppTheme) => void
  onClose: () => void
  onSessionsChanged: () => void
  /** 远程访问整块已搬到侧栏「机器」；这里只留一行指引。 */
  onOpenMachines: () => void
  initialTab?: SettingsTab
}) {
  const titleId = useId()
  const initialTabRef = useRef<HTMLButtonElement | null>(null)
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  // loading = 还没读到索引；unavailable = 读取失败。两者都不能当成 0 个已存档会话，
  // 也不能互相冒充：加载中显示成「索引不可用」等于报告一个没发生的失败。
  const [archived, setArchived] = useState<ArchivedIndexState>({ status: 'loading' })
  const refreshArchived = useCallback(async (): Promise<void> => {
    try {
      setArchived({ status: 'available', projects: await window.scry.listArchivedSessions() })
    } catch {
      setArchived({ status: 'unavailable' })
    }
  }, [])
  useEffect(() => {
    void refreshArchived()
  }, [refreshArchived])
  const remoteArchived = useRemoteProjectGroups('', true)
  const remoteHosts = useDesktopConnections()
  const catalogs = useRemoteCatalogs()
  const uncheckedHosts = remoteHosts.connections.flatMap(connection => {
    const entry = catalogs.get(connection.id)
    if (connection.state === 'connected' && entry?.catalog && !entry.error && !entry.stale) return []
    return [{ connection, failed: Boolean(entry?.error), loading: Boolean(entry?.loading) }]
  })
  const hostsIndex = remoteHosts.error ? 'failed' : !remoteHosts.loaded || remoteHosts.refreshing ? 'unread' : 'ready'
  const archivedCount = archived.status !== 'available' || hostsIndex !== 'ready' || uncheckedHosts.length
    ? undefined
    : archived.projects.reduce((sum, project) => sum + project.sessions.length, 0)
      + remoteArchived.reduce((sum, group) => sum + group.sessions.length, 0)
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={initialTabRef} className="settings-modal" onClose={onClose}>
      <div className="modal-head">
        <b id={titleId}>设置</b>
        <ModalCloseButton onClick={() => requestModalClose()} aria-label={MODAL_COPY.closeSettings} />
      </div>
      <div className="settings-shell">
        <Tabs<SettingsTab>
          className="settings-rail"
          label="设置分区"
          orientation="vertical"
          value={tab}
          onChange={setTab}
          tabRef={(value, node) => { if (value === initialTab) initialTabRef.current = node }}
          items={[
            { value: 'appearance', label: <><Icon name="settings" /> 外观</> },
            { value: 'archived', label: <><Icon name="archive" /> 已存档会话</>, count: archivedCount },
            { value: 'remote', label: <><Icon name="globe" /> {remoteCopy.settingsTab} · {MACHINES_COPY.settingsMigratedTag}</> },
            { value: 'service', label: <><Icon name="server" /> 后台服务</> }
          ].map(item => ({ ...item, value: item.value as SettingsTab, id: `${titleId}-${item.value}-tab`, controls: `${titleId}-pane` }))}
        />
        <div className="settings-pane" role="tabpanel" id={`${titleId}-pane`} aria-labelledby={`${titleId}-${tab}-tab`}>
          {tab === 'appearance' ? (
            <div className="settings-body">
              <div className="settings-copy">
                <b>外观</b>
              </div>
              <Segmented<AppTheme>
                label="界面主题"
                value={theme}
                onChange={onThemeChange}
                options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]}
              />
            </div>
          ) : tab === 'archived' ? (
            <div className="arch-sections">
              <ArchivedChatsPanel
                projects={archived.status === 'available' ? archived.projects : null}
                loading={archived.status === 'loading'}
                onRefresh={refreshArchived}
                onSessionsChanged={onSessionsChanged}
              />
              <ArchivedRemoteChatsPanel groups={remoteArchived} uncheckedHosts={uncheckedHosts} hostsIndex={hostsIndex} />
            </div>
          ) : tab === 'service' ? (
            <BackgroundServiceSettings />
          ) : (
            <div className="settings-migrated">
              <p className="settings-migrated-text">{MACHINES_COPY.settingsMigrated}</p>
              <Button variant="primary" onClick={onOpenMachines}>{MACHINES_COPY.settingsOpenMachines}</Button>
              <p className="settings-migrated-hint">{MACHINES_COPY.settingsHint}</p>
            </div>
          )}
        </div>
      </div>
    </ModalFrame>
  )
}
