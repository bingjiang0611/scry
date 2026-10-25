import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { ProjectMeta } from '../env'


import { Icon } from './primitives/Icon'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { MODAL_COPY } from '../constants/copy'


import { ArchivedRemoteChatsPanel } from './ArchivedRemoteChatsPanel'
import { useRemoteProjectGroups } from './SidebarRemoteProjects'
import './archived-sessions.css'
import { RemotePairing } from './RemotePairing'
import { REMOTE_ACCESS_COPY as remoteCopy } from '../constants/copy'
import type { AppTheme } from '../theme'
import { ModalFrame, requestModalClose } from './ModalFrame'
import { ArchivedChatsPanel } from './ArchivedChatsPanel'

export type SettingsTab = 'appearance' | 'archived' | 'remote'

export function SettingsModal({
  theme,
  onThemeChange,
  onClose,
  onSessionsChanged,
  onNewRemoteSession,
  initialTab = 'appearance'
}: {
  theme: AppTheme
  onThemeChange: (theme: AppTheme) => void
  onClose: () => void
  onSessionsChanged: () => void
  onNewRemoteSession: (connectionId: string, cwd: string) => void
  initialTab?: SettingsTab
}) {
  const titleId = useId()
  const initialTabRef = useRef<HTMLButtonElement>(null)
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  // null = 还没读到索引；不能当成 0 个已存档会话。
  const [archived, setArchived] = useState<ProjectMeta[] | null>(null)
  const refreshArchived = useCallback(async (): Promise<void> => {
    try {
      setArchived(await window.scry.listArchivedSessions())
    } catch {
      setArchived(null)
    }
  }, [])
  useEffect(() => {
    void refreshArchived()
  }, [refreshArchived])
  const remoteArchived = useRemoteProjectGroups('', true)
  const archivedCount = archived == null ? undefined : archived.reduce((sum, project) => sum + project.sessions.length, 0)
    + remoteArchived.reduce((sum, group) => sum + group.sessions.length, 0)
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={initialTabRef} className="settings-modal" onClose={onClose}>
      <div className="modal-head">
        <b id={titleId}>设置</b>
        <ModalCloseButton onClick={() => requestModalClose()} aria-label={MODAL_COPY.closeSettings} />
      </div>
      <div className="settings-shell">
        <nav className="settings-rail" aria-label="设置分区">
          <button
            ref={initialTab === 'appearance' ? initialTabRef : undefined}
            type="button"
            className={`settings-tab ${tab === 'appearance' ? 'active' : ''}`}
            aria-current={tab === 'appearance' ? 'page' : undefined}
            onClick={() => setTab('appearance')}
          >
            <Icon name="settings" /> 外观
          </button>
          <button
            type="button"
            ref={initialTab === 'archived' ? initialTabRef : undefined}
            className={`settings-tab ${tab === 'archived' ? 'active' : ''}`}
            aria-current={tab === 'archived' ? 'page' : undefined}
            onClick={() => setTab('archived')}
          >
            <Icon name="archive" /> 已存档会话
            {archivedCount != null && <span className="cnt">{archivedCount}</span>}
          </button>
          <button
            type="button"
            ref={initialTab === 'remote' ? initialTabRef : undefined}
            className={`settings-tab ${tab === 'remote' ? 'active' : ''}`}
            aria-current={tab === 'remote' ? 'page' : undefined}
            onClick={() => setTab('remote')}
          >
            <Icon name="globe" /> {remoteCopy.settingsTab}
          </button>
        </nav>
        <div className="settings-pane">
          {tab === 'appearance' ? (
            <div className="settings-body">
              <div className="settings-copy">
                <b>外观</b>
              </div>
              <div className="theme-options" role="radiogroup" aria-label="界面主题">
                <button
                  type="button"
                  className={`theme-option ${theme === 'dark' ? 'active' : ''}`}
                  role="radio"
                  aria-checked={theme === 'dark'}
                  onClick={() => onThemeChange('dark')}
                >
                  <span className="theme-preview dark" aria-hidden="true">
                    <span />
                    <i />
                  </span>
                  <span className="theme-option-copy">
                    <b>深色</b>
                  </span>
                  <span className="theme-check" aria-hidden="true"><Icon name="check" /></span>
                </button>
                <button
                  type="button"
                  className={`theme-option ${theme === 'light' ? 'active' : ''}`}
                  role="radio"
                  aria-checked={theme === 'light'}
                  onClick={() => onThemeChange('light')}
                >
                  <span className="theme-preview light" aria-hidden="true">
                    <span />
                    <i />
                  </span>
                  <span className="theme-option-copy">
                    <b>浅色</b>
                  </span>
                  <span className="theme-check" aria-hidden="true"><Icon name="check" /></span>
                </button>
              </div>
            </div>
          ) : tab === 'archived' ? (
            <div className="arch-sections">
              <ArchivedChatsPanel
                projects={archived}
                onRefresh={refreshArchived}
                onSessionsChanged={onSessionsChanged}
              />
              <ArchivedRemoteChatsPanel groups={remoteArchived} />
            </div>
          ) : (
            <RemotePairing onNewSession={onNewRemoteSession} />
          )}
        </div>
      </div>
    </ModalFrame>
  )
}
