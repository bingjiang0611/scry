import type { DetectedAgent } from '../env'
import { Icon } from './primitives/Icon'

export type AppView = 'chat' | 'graph' | 'segments' | 'diagnostics' | 'analytics'

interface ViewChromeProps {
  cwd: string | null
  view: AppView
  agent: DetectedAgent | undefined
  showPanel: boolean
  canTogglePanel?: boolean
  onView: (view: AppView) => void
  onTogglePanel: () => void
}

export function ViewChrome({
  cwd,
  view,
  agent,
  showPanel,
  canTogglePanel = true,
  onView,
  onTogglePanel
}: ViewChromeProps) {
  const agentVersion = agent?.version?.replace(/\s+\(Claude Code\)\s*$/, '')
  return (
    <header className="topbar compact">
      {cwd && (
        <div className="vtabs">
          <button className={`vtab ${view === 'chat' ? 'active' : ''}`} onClick={() => onView('chat')}>
            <Icon name="message" /> 对话
          </button>
          <button className={`vtab ${view === 'graph' ? 'active' : ''}`} onClick={() => onView('graph')}>
            <Icon name="graph" /> 拓扑
          </button>
          <button className={`vtab ${view === 'segments' ? 'active' : ''}`} onClick={() => onView('segments')}>
            <Icon name="chart" /> 分段
          </button>
        </div>
      )}
      <div className="tb-spacer" />
      <div className="tb-statusbar">
        {agent ? (
          <button className="tb-pill agent-pill" title={`${agent.path}${agent.version ? ' · ' + agent.version : ''}`}>
            <span className="dot" /> <span className="agent-name">{agent.name}</span>{' '}
            {agentVersion && <b className="agent-version">{agentVersion}</b>}
          </button>
        ) : (
          <button className="tb-pill agent-pill">
            <span className="dot off" /> <span className="agent-name">未检测到 agent</span>
          </button>
        )}
        {!cwd && (
          <button className="tb-pill cwd-pill" title="未选工作目录">
            <Icon name="folder" /> <b>未选工作目录</b>
          </button>
        )}
        {cwd && canTogglePanel && (
          <button className={`tb-pill panel-pill ${showPanel ? 'on' : ''}`} onClick={onTogglePanel} title="纵览面板">
            <Icon name="grid" /> 面板
          </button>
        )}
      </div>
    </header>
  )
}
