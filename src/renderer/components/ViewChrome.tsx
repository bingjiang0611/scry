import type { McpMeta } from '@shared/provider'
import type { McpLiveStatus } from '@shared/trace'
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
  skillCount?: number
  mcps?: McpMeta[]
  mcpLive?: McpLiveStatus[]
  onView: (view: AppView) => void
  onSkills?: () => void
  onMcp?: () => void
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
  skillCount,
  mcps = [],
  mcpLive = [],
  onView,
  onSkills,
  onMcp,
  onTogglePanel,
  onToggleWorkspace
}: ViewChromeProps) {
  const agentVersion = agent?.version?.replace(/\s+\(Claude Code\)\s*$/, '')
  const mcpSummary = summarizeMcpChrome(mcps, mcpLive)
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
          <span className="tb-context cwd-pill" title="未选工作目录">
            <Icon name="folder" /> <b>未选工作目录</b>
          </span>
        )}
        {cwd && onSkills && (
          <button type="button" className="tb-action integration-pill" onClick={onSkills} title="Skills">
            <Icon name="box" /> 技能
            {skillCount != null && skillCount > 0 && <b>{skillCount}</b>}
          </button>
        )}
        {cwd && onMcp && (
          <button
            type="button"
            className="tb-action integration-pill"
            onClick={onMcp}
            title="MCP"
            aria-label={`MCP · ${mcpSummary.label}`}
          >
            <span className={`dot ${mcpSummary.tone}`} /> MCP
            {mcpSummary.total > 0 && <b>{mcpSummary.connected}/{mcpSummary.total}</b>}
          </button>
        )}
        {cwd && canTogglePanel && (
          <>
            {onToggleWorkspace && (
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

function summarizeMcpChrome(mcps: McpMeta[], live: McpLiveStatus[]): {
  connected: number
  total: number
  tone: 'online' | 'partial' | 'off'
  label: string
} {
  const configuredByName = new Map(mcps.map((mcp) => [mcp.name, mcp]))
  const liveByName = new Map(live.map((status) => [status.name, status]))
  const names = new Set([...configuredByName.keys(), ...liveByName.keys()])
  let connected = 0
  let total = 0

  for (const name of names) {
    const configured = configuredByName.get(name)
    const runtime = liveByName.get(name)
    if (runtime?.status === 'disabled' || (!runtime && configured?.enabled === false)) continue
    total += 1
    if (runtime?.status === 'connected') connected += 1
  }

  if (total === 0) {
    return {
      connected: 0,
      total: 0,
      tone: 'off',
      label: names.size > 0 ? '没有启用的 MCP' : '尚未发现配置'
    }
  }

  const tone = connected === total ? 'online' : 'partial'
  return { connected, total, tone, label: `${connected}/${total} 已连接` }
}
