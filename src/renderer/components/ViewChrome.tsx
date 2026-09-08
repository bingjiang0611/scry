import type { DetectedAgent } from '../env'
import { Icon } from './primitives/Icon'

interface ViewChromeProps {
  cwd: string | null
  agent: DetectedAgent | undefined
  agentScanning?: boolean
  showSummary: boolean
  showPanel: boolean
  onToggleSummary: () => void
  onTogglePanel: () => void
}

export function ViewChrome({
  cwd,
  agent,
  agentScanning = false,
  showSummary,
  showPanel,
  onToggleSummary,
  onTogglePanel
}: ViewChromeProps) {
  const agentVersion = agent?.version?.replace(/\s+\(Claude Code\)\s*$/, '')
  const workspaceLabel = cwd?.split('/').filter(Boolean).at(-1) ?? '不绑定项目'
  return (
    <header className="topbar compact">
      <div className="tb-thread" title={cwd ?? '当前会话未绑定工作目录'}>
        <Icon name="folder" />
        <b>{workspaceLabel}</b>
      </div>
      <div className="tb-spacer" />
      <div className="tb-statusbar" aria-label="会话工具">
        {agent ? (
          <div className="tb-agent-status agent-pill" role="status" title={`${agent.path}${agent.version ? ' · ' + agent.version : ''}`}>
            <span className="dot" /> <span className="agent-name">{agent.name}</span>{' '}
            {agentVersion && <b className="agent-version">{agentVersion}</b>}
          </div>
        ) : (
          <div className="tb-agent-status agent-pill" role="status">
            <span className={`dot ${agentScanning ? 'checking' : 'off'}`} />{' '}
            <span className="agent-name">{agentScanning ? '正在检测 agent…' : '未检测到 agent'}</span>
          </div>
        )}
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
