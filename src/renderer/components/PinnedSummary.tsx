import { useEffect, useMemo, useRef, useState } from 'react'
import type { CapabilityEnvelope, McpSnapshot } from '@shared/provider'
import type { DiffFile } from '@shared/trace'
import type { McpMeta, SkillMeta } from '../env'
import { deriveAgentRows, type AgentRowStatus } from '../agent-panel'
import type { Turn } from '../format'
import { Icon } from './primitives/Icon'

const MAX_WEB_SOURCES = 6
const MAX_SOURCE_TEXT = 120_000
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g

const AGENT_STATUS_LABEL: Record<AgentRowStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  unknown: '状态未知'
}

export interface PinnedSummaryProps {
  cwd: string | null
  gitDiff: DiffFile[]
  skills: SkillMeta[]
  skillCapability: CapabilityEnvelope<SkillMeta[]> | null
  mcps: McpMeta[]
  mcpCapability: CapabilityEnvelope<McpSnapshot> | null
  turns: Turn[]
  busy: boolean
  temporary: boolean
  onDismiss: () => void
  onOpenChanges?: () => void
  onOpenSkills: () => void
  onOpenMcp: () => void
  onOpenAgents: () => void
}

export interface PinnedWebSource {
  url: string
  label: string
}

function clippedJson(value: unknown): string {
  if (value == null) return ''
  try {
    return JSON.stringify(value).slice(0, 20_000)
  } catch {
    return ''
  }
}

function normalizedUrl(raw: string): string | null {
  const candidate = raw.replace(/[),.;:!?，。；：！？\]}]+$/u, '')
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function webSourceLabel(url: string): string {
  const parsed = new URL(url)
  const path = parsed.pathname === '/' ? '' : parsed.pathname
  const label = `${parsed.hostname}${path}`
  return label.length > 48 ? `${label.slice(0, 45)}…` : label
}

export function webSourcesFromTurns(turns: readonly Turn[]): PinnedWebSource[] {
  const sources: PinnedWebSource[] = []
  const seen = new Set<string>()
  let inspected = 0

  const inspect = (text: string | undefined): void => {
    if (!text || inspected >= MAX_SOURCE_TEXT || sources.length >= MAX_WEB_SOURCES) return
    const remaining = MAX_SOURCE_TEXT - inspected
    const bounded = text.slice(0, remaining)
    inspected += bounded.length
    for (const match of bounded.matchAll(URL_PATTERN)) {
      const url = normalizedUrl(match[0])
      if (!url || seen.has(url)) continue
      seen.add(url)
      sources.push({ url, label: webSourceLabel(url) })
      if (sources.length >= MAX_WEB_SOURCES) return
    }
  }

  for (const turn of turns) {
    inspect(turn.userText)
    for (const event of turn.items) {
      inspect(event.text)
      inspect(event.output)
      inspect(clippedJson(event.input))
      if (sources.length >= MAX_WEB_SOURCES || inspected >= MAX_SOURCE_TEXT) return sources
    }
  }
  return sources
}

function capabilityReason(
  skillCapability: CapabilityEnvelope<SkillMeta[]> | null,
  mcpCapability: CapabilityEnvelope<McpSnapshot> | null
): string {
  const reasons = [
    skillCapability?.data == null ? skillCapability?.reason ?? 'Skill 清单尚未可用' : null,
    mcpCapability?.data == null ? mcpCapability?.reason ?? 'MCP 清单尚未可用' : null
  ].filter((reason): reason is string => !!reason)
  return reasons.join('；')
}

export function PinnedSummary({
  cwd,
  gitDiff,
  skills,
  skillCapability,
  mcps,
  mcpCapability,
  turns,
  busy,
  temporary,
  onDismiss,
  onOpenChanges,
  onOpenSkills,
  onOpenMcp,
  onOpenAgents
}: PinnedSummaryProps) {
  const cardRef = useRef<HTMLElement>(null)
  const [expanded, setExpanded] = useState({ inventory: true, web: false, agents: false })
  const webSources = useMemo(() => webSourcesFromTurns(turns), [turns])
  const agentRows = useMemo(() => deriveAgentRows(turns, { busy }), [busy, turns])
  const additions = gitDiff.reduce((total, file) => total + file.added, 0)
  const deletions = gitDiff.reduce((total, file) => total + file.deleted, 0)
  const workspaceName = cwd?.split('/').filter(Boolean).at(-1) ?? '未绑定工作区'
  const inventoryKnown = skillCapability?.data != null && mcpCapability?.data != null
  const inventoryCount = inventoryKnown ? skills.length + mcps.length : null
  const inventoryReason = capabilityReason(skillCapability, mcpCapability)

  useEffect(() => {
    if (!temporary) return
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node) || cardRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[data-pinned-summary-toggle]')) return
      onDismiss()
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsidePointer, true)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [onDismiss, temporary])

  const toggleSection = (section: keyof typeof expanded): void => {
    setExpanded((current) => ({ ...current, [section]: !current[section] }))
  }

  return (
    <div className={`pinned-summary-layer ${temporary ? 'is-temporary' : 'is-persistent'}`}>
      <aside className="pinned-summary-card" aria-label="固定摘要" ref={cardRef}>
        <div className="pinned-summary-section-title">Environment</div>
        <button
          type="button"
          className="pinned-summary-row"
          disabled={!onOpenChanges}
          onClick={onOpenChanges}
          title={gitDiff.length > 0 ? `${gitDiff.length} 个工作区文件的 Git 净改动` : '当前没有可打开的 Git 净改动证据'}
        >
          <span className="pinned-summary-row-icon"><Icon name="diff" /></span>
          <span className="pinned-summary-row-main">Changes</span>
          <span className="pinned-summary-row-value" data-evidence={gitDiff.length > 0 ? 'available' : 'unknown'}>
            {gitDiff.length > 0 ? (
              <><span className="additions">+{additions.toLocaleString()}</span><span className="deletions">−{deletions.toLocaleString()}</span></>
            ) : '—'}
          </span>
        </button>
        <div className="pinned-summary-row is-static">
          <span className="pinned-summary-row-icon"><Icon name="folder" /></span>
          <span className="pinned-summary-row-main" title={cwd ?? '当前会话未绑定工作区'}>{workspaceName}</span>
          <span className="pinned-summary-row-value" />
        </div>

        <div className="pinned-summary-divider" />
        <div className="pinned-summary-section-title">Context</div>

        <section className={`pinned-summary-expandable ${expanded.inventory ? 'is-open' : ''}`}>
          <button
            type="button"
            className="pinned-summary-row"
            aria-expanded={expanded.inventory}
            onClick={() => toggleSection('inventory')}
            title={inventoryKnown ? `${skills.length} Skills · ${mcps.length} MCP` : inventoryReason}
          >
            <span className="pinned-summary-row-icon"><Icon name="tool" /></span>
            <span className="pinned-summary-row-main">Skills &amp; MCP</span>
            <span className="pinned-summary-row-value">
              <span className="pinned-summary-count" data-evidence={inventoryKnown ? 'available' : 'unavailable'}>
                {inventoryCount ?? '—'}
              </span>
              <Icon name={expanded.inventory ? 'chevronUp' : 'chevronDown'} />
            </span>
          </button>
          {expanded.inventory && (
            <div className="pinned-summary-detail">
              {skills.map((skill) => (
                <button type="button" className="pinned-summary-detail-row" key={`skill:${skill.dir}`} onClick={onOpenSkills}>
                  <span className="pinned-summary-detail-icon"><Icon name="tool" /></span>
                  <span title={skill.description}>{skill.name}</span>
                  {!skill.enabled && <em>disabled</em>}
                </button>
              ))}
              {mcps.map((mcp) => (
                <button type="button" className="pinned-summary-detail-row" key={`mcp:${mcp.targetId ?? `${mcp.scope}:${mcp.name}`}`} onClick={onOpenMcp}>
                  <span className="pinned-summary-detail-icon"><Icon name="plug" /></span>
                  <span title={mcp.detail}>{mcp.name}</span>
                  {!mcp.enabled && <em>disabled</em>}
                </button>
              ))}
              {skills.length === 0 && mcps.length === 0 && (
                <div className="pinned-summary-empty" data-evidence={inventoryKnown ? 'available' : 'unavailable'}>
                  {inventoryKnown ? '当前清单为空' : inventoryReason}
                </div>
              )}
            </div>
          )}
        </section>

        <section className={`pinned-summary-expandable ${expanded.web ? 'is-open' : ''}`}>
          <button type="button" className="pinned-summary-row" aria-expanded={expanded.web} onClick={() => toggleSection('web')} title="仅统计当前已加载 transcript 中出现的 http(s) 引用，不代表已成功读取">
            <span className="pinned-summary-row-icon"><Icon name="globe" /></span>
            <span className="pinned-summary-row-main">Web references</span>
            <span className="pinned-summary-row-value">
              <span className="pinned-summary-count">{webSources.length}</span>
              <Icon name={expanded.web ? 'chevronUp' : 'chevronDown'} />
            </span>
          </button>
          {expanded.web && (
            <div className="pinned-summary-detail">
              {webSources.map((source) => (
                <div className="pinned-summary-detail-row is-static" key={source.url}>
                  <span className="pinned-summary-detail-icon"><Icon name="globe" /></span>
                  <span title={source.url}>{source.label}</span>
                </div>
              ))}
              {webSources.length === 0 && <div className="pinned-summary-empty">当前已加载轮次未出现网页引用</div>}
            </div>
          )}
        </section>

        <section className={`pinned-summary-expandable ${expanded.agents ? 'is-open' : ''}`}>
          <button type="button" className="pinned-summary-row" aria-expanded={expanded.agents} onClick={() => toggleSection('agents')} title="仅展示当前已加载 TraceEvent 中可证明的子 Agent">
            <span className="pinned-summary-row-icon"><Icon name="agents" /></span>
            <span className="pinned-summary-row-main">Subagents</span>
            <span className="pinned-summary-row-value">
              <span className="pinned-summary-count" data-evidence={agentRows.length > 0 ? 'available' : 'unknown'}>{agentRows.length || '—'}</span>
              <Icon name={expanded.agents ? 'chevronUp' : 'chevronDown'} />
            </span>
          </button>
          {expanded.agents && (
            <div className="pinned-summary-detail">
              {agentRows.map((agent) => (
                <button type="button" className="pinned-summary-detail-row" key={agent.id} onClick={onOpenAgents}>
                  <span className="pinned-summary-detail-icon"><Icon name="agents" /></span>
                  <span>{agent.name}</span>
                  <em data-status={agent.status}>{AGENT_STATUS_LABEL[agent.status]}</em>
                </button>
              ))}
              {agentRows.length === 0 && <div className="pinned-summary-empty" data-evidence="unknown">未观测到子 Agent</div>}
            </div>
          )}
        </section>
      </aside>
    </div>
  )
}
