import type { CSSProperties, ReactNode } from 'react'

export interface AppShellProps {
  style: CSSProperties
  rightPanelMode?: 'overview' | 'review'
  sidebar: ReactNode
  sidebarSplitter: ReactNode
  main: ReactNode
  rightSplitter?: ReactNode
  rightPanel?: ReactNode
  modals?: ReactNode
}

export function AppShell({ style, rightPanelMode = 'overview', sidebar, sidebarSplitter, main, rightSplitter, rightPanel, modals }: AppShellProps) {
  const hasRightPanel = Boolean(rightPanel)
  return (
    <div className={`app app-shell ${hasRightPanel ? `has-right-panel right-panel-${rightPanelMode}` : ''}`} style={style}>
      {sidebar}
      {sidebarSplitter}
      <div className="main-area" id="main-pane">
        {main}
      </div>
      {hasRightPanel && (
        <>
          {rightSplitter}
          <div className="right-panel-slot" id="overview-pane">
            {rightPanel}
          </div>
        </>
      )}
      {modals}
    </div>
  )
}
