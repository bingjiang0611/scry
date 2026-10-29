// 调用明细：逻辑调用去重与 skill 投影、工具显示名/参数、按 工具/skill/子agent/mcp 分类计数。
import { mcpCallsForEvent, type TraceEvent } from '@shared/trace'
import { logicalCallEventsForTurn as deduplicateCallEvents } from '@shared/logical-calls'
import { projectRequestedSkillLoads } from './skill-load-evidence'
import { basename } from './format-text'
import { hookCommandLabel } from './format-hook-command'

export function logicalCallEventsForTurn(items: TraceEvent[], userText?: string): TraceEvent[] {
  return projectRequestedSkillLoads(deduplicateCallEvents(items), userText)
}

export function toolDisplayName(ev: TraceEvent): string {
  if (ev.isMcp) {
    const action = ev.mcpAction ?? (ev.tool ?? '').split('__').slice(2).join('__')
    return action || 'MCP'
  }
  if (ev.kind === 'agent') return 'Task'
  if (ev.kind === 'skill') return 'Skill'
  if (ev.kind === 'hook') return hookCommandLabel(ev.hookCommand) ?? ev.hookName ?? ev.tool ?? 'Hook'
  return ev.tool ?? ev.stage
}

export function toolArg(ev: TraceEvent): string {
  if (ev.filePath) return basename(ev.filePath)
  const inp = ev.input as Record<string, unknown> | undefined
  if (typeof inp?.command === 'string') return inp.command.slice(0, 80)
  if (typeof inp?.pattern === 'string') return inp.pattern
  if (typeof inp?.subagent_type === 'string') return inp.subagent_type
  if (typeof inp?.description === 'string') return inp.description
  if (ev.isMcp) return ''
  return ev.name ?? ''
}

export function toolMeta(ev: TraceEvent): string {
  const inp = ev.input as Record<string, unknown> | undefined
  if (ev.tool === 'Write' && typeof inp?.content === 'string') {
    return `${inp.content.split('\n').length} lines`
  }
  return ''
}

// 调用明细（本会话）：把 tool_use 事件按 工具/skill/子agent/mcp 分类计数，供右栏监控/定位。
// 只数 tool_use（排除 stage==='tool_result'，否则每次调用会被结果事件重复计一遍）。
export interface CallCount {
  name: string
  count: number
}
export interface McpGroup {
  server: string
  total: number
  actions: { action: string; tool: string; count: number }[] // tool = mcpTool 或原始 tool（用于 jump 定位）
}
export interface CallBreakdown {
  tools: CallCount[] // 普通工具（kind=tool，非 mcp）
  skills: CallCount[] // kind=skill
  agents: CallCount[] // kind=agent（子 agent / Task）
  mcp: McpGroup[] // kind=tool && isMcp，按 server 分组
  ordinaryToolTotal: number
  skillTotal: number
  agentTotal: number
  mcpTotal: number
  totalCalls: number // 四类逻辑调用之和
  toolTotal: number // 兼容旧调用方：等于 totalCalls；新 UI 不应把它标成“工具”
}

export function aggregateCalls(items: TraceEvent[]): CallBreakdown {
  const tools = new Map<string, number>()
  const skills = new Map<string, number>()
  const agents = new Map<string, number>()
  const mcpMap = new Map<string, McpGroup>()
  for (const e of items) {
    if (e.stage === 'tool_result') continue // 工具结果不是一次调用，跳过
    if (e.kind === 'skill') {
      const n = e.name ?? 'skill'
      skills.set(n, (skills.get(n) ?? 0) + 1)
    } else if (e.kind === 'agent') {
      const n = e.name ?? 'agent'
      agents.set(n, (agents.get(n) ?? 0) + 1)
    } else if (e.kind === 'tool' && e.isMcp) {
      const refs = mcpCallsForEvent(e)
      for (const ref of refs) {
        let g = mcpMap.get(ref.server)
        if (!g) {
          g = { server: ref.server, total: 0, actions: [] }
          mcpMap.set(ref.server, g)
        }
        g.total++
        const a = g.actions.find((x) => x.tool === ref.tool)
        if (a) a.count++
        else g.actions.push({ action: ref.action, tool: ref.tool, count: 1 })
      }
    } else if (e.kind === 'tool') {
      const n = e.tool ?? e.stage
      tools.set(n, (tools.get(n) ?? 0) + 1)
    }
  }
  const toRows = (m: Map<string, number>): CallCount[] =>
    [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const mcp = [...mcpMap.values()].sort((a, b) => b.total - a.total)
  for (const g of mcp) g.actions.sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
  const ordinaryToolTotal = [...tools.values()].reduce((sum, count) => sum + count, 0)
  const skillTotal = [...skills.values()].reduce((sum, count) => sum + count, 0)
  const agentTotal = [...agents.values()].reduce((sum, count) => sum + count, 0)
  const mcpTotal = mcp.reduce((sum, group) => sum + group.total, 0)
  const totalCalls = ordinaryToolTotal + skillTotal + agentTotal + mcpTotal
  return {
    tools: toRows(tools),
    skills: toRows(skills),
    agents: toRows(agents),
    mcp,
    ordinaryToolTotal,
    skillTotal,
    agentTotal,
    mcpTotal,
    totalCalls,
    toolTotal: totalCalls
  }
}
