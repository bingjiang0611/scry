import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useSampledTurns } from '../hooks/useSampledTurns'
import type { DiffFile, TraceEvent } from '@shared/trace'
import { sessionCapabilityCalls } from '../session-capability-calls'
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

export type PinnedSummarySection = 'inventory' | 'web' | 'agents'

export interface PinnedSummaryProps {
  cwd: string | null
  gitDiff: DiffFile[]
  turns: Turn[]
  busy: boolean
  temporary: boolean
  expandedSections: ReadonlySet<PinnedSummarySection>
  onDismiss: () => void
  onToggleSection: (section: PinnedSummarySection) => void
  onOpenChanges?: () => void
  onOpenCall: (runId: string, event: TraceEvent) => void
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

interface PinnedWebSourceScan {
  sources: PinnedWebSource[]
  complete: boolean
}

function scanWebSourcesFromTurns(turns: readonly Turn[]): PinnedWebSourceScan {
  const sources: PinnedWebSource[] = []
  const seen = new Set<string>()
  let inspected = 0
  let complete = true

  const inspect = (text: string | undefined): void => {
    if (!text || sources.length >= MAX_WEB_SOURCES) return
    if (inspected >= MAX_SOURCE_TEXT) {
      complete = false
      return
    }
    const remaining = MAX_SOURCE_TEXT - inspected
    const bounded = text.slice(0, remaining)
    if (bounded.length < text.length) complete = false
    inspected += bounded.length
    for (const match of bounded.matchAll(URL_PATTERN)) {
      const url = normalizedUrl(match[0])
      if (!url || seen.has(url)) continue
      seen.add(url)
      sources.push({ url, label: webSourceLabel(url) })
      if (sources.length >= MAX_WEB_SOURCES) {
        complete = false
        return
      }
    }
  }

  for (const turn of turns) {
    inspect(turn.userText)
    for (const event of turn.items) {
      inspect(event.text)
      inspect(event.output)
      inspect(clippedJson(event.input))
      if (sources.length >= MAX_WEB_SOURCES || inspected >= MAX_SOURCE_TEXT) return { sources, complete: false }
    }
  }
  return { sources, complete }
}

export function webSourcesFromTurns(turns: readonly Turn[]): PinnedWebSource[] {
  return scanWebSourcesFromTurns(turns).sources
}

export function PinnedSummary(props: PinnedSummaryProps) {
  // Links and child-agent evidence can arrive in text, not just structural events.
  // Sample the complete snapshot rather than dropping those updates. The first run
  // identifies the loaded session; loading an older page also refreshes immediately.
  const turns = useSampledTurns(props.turns, props.turns[0]?.runId ?? null, props.busy)
  return <MemoPinnedSummaryBody {...props} turns={turns} />
}

function PinnedSummaryBody({
  cwd,
  gitDiff,
  turns,
  busy,
  temporary,
  expandedSections,
  onDismiss,
  onToggleSection,
  onOpenChanges,
  onOpenCall,
  onOpenAgents
}: PinnedSummaryProps) {
  const cardRef = useRef<HTMLElement>(null)
  const detailsId = useId()
  const webSourceScan = useMemo(() => scanWebSourcesFromTurns(turns), [turns])
  const webSources = webSourceScan.sources
  const agentRows = useMemo(() => deriveAgentRows(turns, { busy }), [busy, turns])
  const additions = gitDiff.reduce((total, file) => total + file.added, 0)
  const deletions = gitDiff.reduce((total, file) => total + file.deleted, 0)
  const workspaceName = cwd?.split('/').filter(Boolean).at(-1) ?? '未绑定工作区'
  const capabilityCalls = useMemo(() => sessionCapabilityCalls(turns), [turns])
  const callScope = '当前会话已加载记录中观测到的 Skill 调用/注入、明确请求后的技能文件加载推断与 MCP 工具调用；不代表完整调用清单，未观测到不等于未调用'
  const inventoryExpanded = expandedSections.has('inventory')
  const webExpanded = expandedSections.has('web')
  const agentsExpanded = expandedSections.has('agents')
  const showInventory = capabilityCalls.length > 0
  const showWebReferences = webSources.length > 0
  const showAgents = agentRows.length > 0
  const showContext = showInventory || showWebReferences || showAgents

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

  return (
    <div className={`pinned-summary-layer ${temporary ? 'is-temporary' : 'is-persistent'}`}>
      <aside className="pinned-summary-card" aria-label="固定摘要" ref={cardRef}>
        <div className="pinned-summary-section-title">Environment</div>
        {gitDiff.length > 0 && (
          <button
            type="button"
            className="pinned-summary-row"
            disabled={!onOpenChanges}
            onClick={onOpenChanges}
            title={`${gitDiff.length} 个工作区文件的 Git 净改动`}
          >
            <span className="pinned-summary-row-icon"><Icon name="diff" /></span>
            <span className="pinned-summary-row-main">Changes</span>
            <span className="pinned-summary-row-value" data-evidence="available">
              <span className="additions">+{additions.toLocaleString()}</span><span className="deletions">−{deletions.toLocaleString()}</span>
            </span>
          </button>
        )}
        <div className="pinned-summary-row is-static">
          <span className="pinned-summary-row-icon"><Icon name="folder" /></span>
          <span className="pinned-summary-row-main" title={cwd ?? '当前会话未绑定工作区'}>{workspaceName}</span>
          <span className="pinned-summary-row-value" />
        </div>

        {showContext && (
          <>
            <div className="pinned-summary-divider" />
            <div className="pinned-summary-section-title">Context</div>
          </>
        )}

        {showInventory && (
          <section className={`pinned-summary-expandable ${inventoryExpanded ? 'is-open' : ''}`}>
            <button
              type="button"
              className="pinned-summary-row"
              aria-expanded={inventoryExpanded}
              aria-controls={`${detailsId}-inventory`}
              onClick={() => onToggleSection('inventory')}
              title={callScope}
            >
              <span className="pinned-summary-row-icon"><Icon name="tool" /></span>
              <span className="pinned-summary-row-main">Skills &amp; MCP · 本会话</span>
              <span className="pinned-summary-row-value">
                <span className="pinned-summary-count" data-evidence="observed" title="已观测到的 Skill / MCP 工具种类数，非配置数量">
                  {capabilityCalls.length}
                </span>
                <Icon name={inventoryExpanded ? 'chevronUp' : 'chevronDown'} />
              </span>
            </button>
            <div id={`${detailsId}-inventory`} className="pinned-summary-detail" hidden={!inventoryExpanded}>
              {inventoryExpanded && capabilityCalls.map((call) => (
                <button
                  type="button"
                  className="pinned-summary-detail-row"
                  key={call.key}
                  onClick={() => onOpenCall(call.runId, call.event)}
                  title={`${call.name} · 已观测 ${call.count} 次${call.inferredCount ? `（其中 ${call.inferredCount} 次为明确请求并成功读取技能文件后的加载推断，非原生 Skill 调用）` : ''} · 点击定位会话证据`}
                >
                  <span className="pinned-summary-detail-icon"><Icon name={call.kind === 'skill' ? 'tool' : 'plug'} /></span>
                  <span>{call.name}</span>
                  <em>×{call.count}</em>
                </button>
              ))}
            </div>
          </section>
        )}

        {showWebReferences && (
          <section className={`pinned-summary-expandable ${webExpanded ? 'is-open' : ''}`}>
            <button
              type="button"
              className="pinned-summary-row"
              aria-expanded={webExpanded}
              aria-controls={`${detailsId}-web`}
              onClick={() => onToggleSection('web')}
              title="仅统计当前已加载 transcript 中出现的 http(s) 引用，不代表已成功读取"
            >
              <span className="pinned-summary-row-icon"><Icon name="globe" /></span>
              <span className="pinned-summary-row-main">Web references</span>
              <span className="pinned-summary-row-value">
                <span className="pinned-summary-count" data-evidence="observed">
                  {webSources.length}{webSourceScan.complete ? '' : '+'}
                </span>
                <Icon name={webExpanded ? 'chevronUp' : 'chevronDown'} />
              </span>
            </button>
            <div id={`${detailsId}-web`} className="pinned-summary-detail" hidden={!webExpanded}>
              {webExpanded && webSources.map((source) => (
                <div className="pinned-summary-detail-row is-static" key={source.url}>
                  <span className="pinned-summary-detail-icon"><Icon name="globe" /></span>
                  <span title={source.url}>{source.label}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {showAgents && (
          <section className={`pinned-summary-expandable ${agentsExpanded ? 'is-open' : ''}`}>
            <button
              type="button"
              className="pinned-summary-row"
              aria-expanded={agentsExpanded}
              aria-controls={`${detailsId}-agents`}
              onClick={() => onToggleSection('agents')}
              title="仅展示当前已加载 TraceEvent 中可证明的子 Agent"
            >
              <span className="pinned-summary-row-icon"><Icon name="agents" /></span>
              <span className="pinned-summary-row-main">Subagents</span>
              <span className="pinned-summary-row-value">
                <span className="pinned-summary-count" data-evidence="available">{agentRows.length}</span>
                <Icon name={agentsExpanded ? 'chevronUp' : 'chevronDown'} />
              </span>
            </button>
            <div id={`${detailsId}-agents`} className="pinned-summary-detail" hidden={!agentsExpanded}>
              {agentsExpanded && agentRows.map((agent) => (
                <button type="button" className="pinned-summary-detail-row" key={agent.id} onClick={onOpenAgents}>
                  <span className="pinned-summary-detail-icon"><Icon name="agents" /></span>
                  <span>{agent.name}</span>
                  <em data-status={agent.status}>{AGENT_STATUS_LABEL[agent.status]}</em>
                </button>
              ))}
            </div>
          </section>
        )}
      </aside>
    </div>
  )
}

export interface PinnedSummaryVisibility {
  visible: boolean
  persistent: boolean
  dismiss: () => void
  toggle: () => void
}

const MemoPinnedSummaryBody = memo(PinnedSummaryBody)

export function usePinnedSummaryVisibility(active: boolean, panelVisible: boolean): PinnedSummaryVisibility {
  const [persistentOpen, setPersistentOpen] = useState(false)
  const [overlayOpen, setOverlayOpen] = useState(false)

  useEffect(() => {
    if (!panelVisible || !active) setOverlayOpen(false)
  }, [active, panelVisible])

  const dismiss = useCallback((): void => setOverlayOpen(false), [])
  const toggle = useCallback((): void => {
    if (!active) return
    if (panelVisible) setOverlayOpen((current) => !current)
    else setPersistentOpen((current) => !current)
  }, [active, panelVisible])

  return {
    persistent: active && !panelVisible,
    visible: active && (panelVisible ? overlayOpen : persistentOpen),
    dismiss,
    toggle
  }
}

export interface PinnedSummaryHostProps extends Omit<PinnedSummaryProps, 'expandedSections' | 'onToggleSection'> {
  visible: boolean
}

export function PinnedSummaryHost({ visible, ...props }: PinnedSummaryHostProps) {
  const [expandedSections, setExpandedSections] = useState<Set<PinnedSummarySection>>(
    () => new Set(['inventory'])
  )
  const toggleSection = useCallback((section: PinnedSummarySection): void => {
    setExpandedSections((current) => {
      const next = new Set(current)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }, [])

  if (!visible) return null
  return (
    <PinnedSummary
      {...props}
      expandedSections={expandedSections}
      onToggleSection={toggleSection}
    />
  )
}
