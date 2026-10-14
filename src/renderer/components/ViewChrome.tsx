import { Icon } from './primitives/Icon'
import './remote-location.css'

interface ViewChromeProps {
  cwd: string | null
  showSummary: boolean
  showPanel: boolean
  // Absent for remote sessions: the pinned summary reads local git/turn evidence.
  onToggleSummary?: () => void
  onTogglePanel: () => void
  // The machine the Agent executes on. Remote hosts get a distinct pill so the
  // execution location is visible without a separate page or banner.
  machine?: { label: string; remote: boolean; state?: 'connected' | 'disconnected' | 'pairing' | 'unknown' }
  panelLabel?: string
}

export function ViewChrome({
  cwd,
  showSummary,
  showPanel,
  onToggleSummary,
  onTogglePanel,
  machine = { label: '本机', remote: false },
  panelLabel = '右侧工作区'
}: ViewChromeProps) {
  const workspaceLabel = cwd?.split('/').filter(Boolean).at(-1) ?? '不绑定项目'
  return (
    <header className="topbar compact">
      <div className="tb-thread" title={cwd ?? '当前会话未绑定工作目录'}>
        <Icon name="folder" />
        <span
          className={`execution-location ${machine.remote ? 'is-remote' : ''}`}
          data-state={machine.state}
          aria-label={`执行位置：${machine.label}`}
        >
          {machine.remote && <Icon name="server" />}
          {machine.label}
        </span>
        <b>{workspaceLabel}</b>
      </div>
      <div className="tb-spacer" />
      <div className="tb-statusbar" aria-label="会话工具">
        {onToggleSummary && <button
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
        </button>}
        <button
          type="button"
          className={`tb-action panel-pill ${showPanel ? 'on' : ''}`}
          onClick={onTogglePanel}
          title={panelLabel}
          aria-label={panelLabel}
          aria-pressed={showPanel}
        >
          <Icon name="panel" />
          <span className="tb-action-label">面板</span>
        </button>
      </div>
    </header>
  )
}
