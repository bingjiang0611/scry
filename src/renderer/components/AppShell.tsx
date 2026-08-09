import type { CSSProperties, ReactNode } from 'react'

export interface AppShellProps {
  style: CSSProperties
  rightPanelMode?: 'overview' | 'review' | 'workspace' | 'surface'
  rightPanelMaximized?: boolean
  rightPanelHidden?: boolean
  sidebarCollapsed?: boolean
  sidebar: ReactNode
  sidebarSplitter: ReactNode
  main: ReactNode
  rightSplitter?: ReactNode
  rightPanel?: ReactNode
  modals?: ReactNode
}

export function AppShell({
  style,
  rightPanelMode = 'overview',
  rightPanelMaximized = false,
  rightPanelHidden = false,
  sidebarCollapsed = false,
  sidebar,
  sidebarSplitter,
  main,
  rightSplitter,
  rightPanel,
  modals
}: AppShellProps) {
  const hasRightPanel = Boolean(rightPanel)
  return (
    <div
      className={`app app-shell ${hasRightPanel ? `has-right-panel right-panel-${rightPanelMode}` : ''}${hasRightPanel && rightPanelMaximized ? ' right-panel-maximized' : ''}${hasRightPanel && rightPanelHidden ? ' right-panel-hidden' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
      style={style}
    >
      {sidebar}
      {sidebarSplitter}
      <div className="main-area" id="main-pane">
        {main}
      </div>
      {hasRightPanel && (
        <>
          {rightSplitter}
          <div className="right-panel-slot" id="right-surface-pane">
            {rightPanel}
          </div>
        </>
      )}
      {modals}
    </div>
  )
}
