import type { DetectedAgent } from '../env'
import { Icon } from './primitives/Icon'

export type AppView = 'chat' | 'graph' | 'segments' | 'diagnostics' | 'analytics'

interface ViewChromeProps {
  cwd: string | null
  view: AppView
  agent: DetectedAgent | undefined
  agentScanning?: boolean
  showPanel: boolean
  showWorkspace?: boolean
  canTogglePanel?: boolean
  onView: (view: AppView) => void
  onTogglePanel: () => void
  onToggleWorkspace?: () => void
}

export function ViewChrome({
  cwd,
  view,
  agent,
  agentScanning = false,
  showPanel,
  showWorkspace = false,
  canTogglePanel = true,
  onView,
  onTogglePanel,
  onToggleWorkspace
}: ViewChromeProps) {
  const agentVersion = agent?.version?.replace(/\s+\(Claude Code\)\s*$/, '')
  return (
    <header className="topbar compact">
      {cwd && (
        <nav className="vtabs" aria-label="会话视图">
          <button
            type="button"
            className={`vtab ${view === 'chat' ? 'active' : ''}`}
            aria-current={view === 'chat' ? 'page' : undefined}
            onClick={() => onView('chat')}
          >
            <Icon name="message" /> 对话
          </button>
          <button
            type="button"
            className={`vtab ${view === 'graph' ? 'active' : ''}`}
            aria-current={view === 'graph' ? 'page' : undefined}
            onClick={() => onView('graph')}
          >
            <Icon name="graph" /> 拓扑
          </button>
          <button
            type="button"
            className={`vtab ${view === 'segments' ? 'active' : ''}`}
            aria-current={view === 'segments' ? 'page' : undefined}
            onClick={() => onView('segments')}
          >
            <Icon name="chart" /> 分段
          </button>
        </nav>
      )}
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
        {canTogglePanel && (
          <>
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
              title="纵览面板"
              aria-pressed={showPanel}
            >
              <Icon name="grid" /> 面板
            </button>
          </>
        )}
      </div>
    </header>
  )
}
