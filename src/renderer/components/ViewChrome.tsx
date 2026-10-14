import { Icon } from './primitives/Icon'

interface ViewChromeProps {
  cwd: string | null
  showSummary: boolean
  showPanel: boolean
  onToggleSummary: () => void
  onTogglePanel: () => void
}

export function ViewChrome({
  cwd,
  showSummary,
  showPanel,
  onToggleSummary,
  onTogglePanel
}: ViewChromeProps) {
  const workspaceLabel = cwd?.split('/').filter(Boolean).at(-1) ?? '不绑定项目'
  return (
    <header className="topbar compact">
      <div className="tb-thread" title={cwd ?? '当前会话未绑定工作目录'}>
        <Icon name="folder" />
        <span className="execution-location" aria-label="执行位置：本机">本机</span>
        <b>{workspaceLabel}</b>
      </div>
      <div className="tb-spacer" />
      <div className="tb-statusbar" aria-label="会话工具">
        <button
          type="button"
          className={`tb-action panel-pill summary-pill ${showSummary ? 'on' : ''}`}
          data-pinned-summary-toggle
          onClick={onToggleSummary}
          title={showSummary ? '收起摘要' : '显示摘要'}
          aria-label="切换固定摘要"
          aria-pressed={showSummary}
        >
          <Icon name="summary" />
          <span className="tb-action-label">摘要</span>
        </button>
        <button
          type="button"
          className={`tb-action panel-pill ${showPanel ? 'on' : ''}`}
          onClick={onTogglePanel}
          title="右侧工作区"
          aria-label="右侧工作区"
          aria-pressed={showPanel}
        >
          <Icon name="panel" />
          <span className="tb-action-label">面板</span>
        </button>
      </div>
    </header>
  )
}
