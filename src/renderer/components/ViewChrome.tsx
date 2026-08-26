import type { DetectedAgent } from '../env'
import { Icon } from './primitives/Icon'

interface ViewChromeProps {
  cwd: string | null
  agent: DetectedAgent | undefined
  agentScanning?: boolean
  showPanel: boolean
  showWorkspace?: boolean
  onTogglePanel: () => void
  onToggleWorkspace?: () => void
}

export function ViewChrome({
  cwd,
  agent,
  agentScanning = false,
  showPanel,
  showWorkspace = false,
  onTogglePanel,
  onToggleWorkspace
}: ViewChromeProps) {
  const agentVersion = agent?.version?.replace(/\s+\(Claude Code\)\s*$/, '')
  return (
    <header className="topbar compact">
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
        {!cwd && (
          <span className="tb-context cwd-pill" title="当前运行未指定工作目录">
            <Icon name="folder" /> <b>不绑定项目</b>
          </span>
        )}
        {cwd && onToggleWorkspace && (
          <button
            type="button"
            className={`tb-action panel-pill ${showWorkspace ? 'on' : ''}`}
            onClick={onToggleWorkspace}
            title="工作区文件"
            aria-pressed={showWorkspace}
          >
            <Icon name="folder" /> 文件
          </button>
        )}
        <button
          type="button"
          className={`tb-action panel-pill ${showPanel ? 'on' : ''}`}
          onClick={onTogglePanel}
          title="右侧工作区"
          aria-pressed={showPanel}
        >
          <Icon name="panel" /> 面板
        </button>
      </div>
    </header>
  )
}
