import { Icon } from './primitives/Icon'

export interface SidebarNavProps {
  onAnalytics?: () => void
  analyticsActive?: boolean
  onMachines?: () => void
  machinesActive?: boolean
  onLlmPerformance?: () => void
  onSkills?: () => void
  onMcp?: () => void
  onMetaPrompts?: () => void
  metaPromptsActive?: boolean
}

// 侧栏顶部的顶层入口。只在宿主订阅了对应动作时出现，当前页用 aria-current 标出。
export function SidebarNav({
  onAnalytics, analyticsActive = false, onMachines, machinesActive = false,
  onLlmPerformance, onSkills, onMcp, onMetaPrompts, metaPromptsActive = false
}: SidebarNavProps): JSX.Element | null {
  if (!(onAnalytics || onLlmPerformance || onSkills || onMcp || onMetaPrompts || onMachines)) return null
  return (
    <nav className="sb-nav" aria-label="主要视图">
      {onAnalytics && (
        <button type="button" className={`sb-navitem ${analyticsActive ? 'active' : ''}`}
          aria-current={analyticsActive ? 'page' : undefined} onClick={onAnalytics}>
          <Icon name="overview" /> 分析
        </button>
      )}
      {onMachines && (
        <button type="button" className={`sb-navitem ${machinesActive ? 'active' : ''}`}
          aria-current={machinesActive ? 'page' : undefined} onClick={onMachines}>
          <Icon name="server" /> 机器
        </button>
      )}
      {onLlmPerformance && (
        <button type="button" className="sb-navitem" onClick={onLlmPerformance} title="LLM 性能" aria-haspopup="dialog">
          <Icon name="chart" /> LLM 性能
        </button>
      )}
      {onSkills && (
        <button type="button" className="sb-navitem" onClick={onSkills} title="Skills" aria-haspopup="dialog">
          <Icon name="box" /> 技能
        </button>
      )}
      {onMcp && (
        <button type="button" className="sb-navitem" onClick={onMcp} title="MCP" aria-haspopup="dialog" aria-label="MCP">
          <Icon name="cube" /> MCP
        </button>
      )}
      {onMetaPrompts && (
        <button type="button" className={`sb-navitem ${metaPromptsActive ? 'active' : ''}`}
          aria-current={metaPromptsActive ? 'page' : undefined} onClick={onMetaPrompts}>
          <Icon name="terminal" /> Meta Prompts
        </button>
      )}
    </nav>
  )
}
