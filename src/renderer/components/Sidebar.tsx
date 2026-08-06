// 左侧栏（蓝本 welcome/chat 通用）：brand+版本 / 新建会话 / 搜索 / 按工作目录分组的历史会话（右键删除）。
import { useEffect, useRef, useState } from 'react'
import { relTime } from '../format'
import { Icon } from './primitives/Icon'
import type { ProjectMeta } from '../env'
import type { McpMeta, SessionProviderId } from '@shared/provider'
import type { CatalogHealth } from '@shared/provider'
import type { McpLiveStatus } from '@shared/trace'

const activeTimeTitle = (ms: number): string =>
  `最近活动：${new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(ms))}`

export function Sidebar({
  id,
  projects,
  activeCwd,
  activeSessionId = null,
  activeProviderId,
  runningRunIds = new Set<string>(),
  version = '0.1.0',
  onNewChat,
  onPick,
  onDelete,
  onDiagnostics,
  diagnosticsActive = false,
  onAnalytics,
  analyticsActive = false,
  onSkills,
  skillCount,
  onMcp,
  mcps = [],
  mcpLive = [],
  catalogHealth,
  onSettings,
  themeLabel = '深色'
}: {
  id?: string
  projects: ProjectMeta[]
  activeCwd: string | null
  activeSessionId?: string | null
  activeProviderId?: SessionProviderId
  runningRunIds?: ReadonlySet<string>
  version?: string
  onNewChat: () => void
  onPick: (cwd: string, sessionId: string, providerId: SessionProviderId, externalSessionId?: string, runId?: string) => void
  onDelete: (cwd: string, sessionId: string, providerId: SessionProviderId, externalSessionId?: string) => void
  onDiagnostics?: () => void
  diagnosticsActive?: boolean
  onAnalytics?: () => void
  analyticsActive?: boolean
  onSkills?: () => void
  skillCount?: number
  onMcp?: () => void
  mcps?: McpMeta[]
  mcpLive?: McpLiveStatus[]
  catalogHealth?: CatalogHealth
  onSettings?: () => void
  themeLabel?: string
}) {
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const contextActionRef = useRef<HTMLButtonElement>(null)
  const [ctx, setCtx] = useState<{
    x: number
    y: number
    cwd: string
    sessionId: string
    providerId: SessionProviderId
    externalSessionId?: string
    opener: HTMLButtonElement
  } | null>(null)
  useEffect(() => {
    if (ctx) contextActionRef.current?.focus()
  }, [ctx])
  const closeContextMenu = (): void => {
    const opener = ctx?.opener
    setCtx(null)
    window.requestAnimationFrame(() => opener?.focus())
  }
  const toggle = (cwd: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(cwd) ? next.delete(cwd) : next.add(cwd)
      return next
    })
  const ql = q.trim().toLowerCase()
  const filtered = ql
    ? projects
        .map((p) => ({ ...p, sessions: p.sessions.filter((s) => s.preview.toLowerCase().includes(ql)) }))
        .filter((p) => p.sessions.length > 0)
    : projects
  const mcpSummary = summarizeMcpNav(mcps, mcpLive)
  return (
    <aside className="sidebar" id={id} aria-label="会话导航">
      <div className="sb-brand">
        <span className="name">Scry</span>
        <span className="ver">{version}</span>
      </div>
      <button className="sb-new" onClick={onNewChat}>
        <Icon name="plus" /> 新建会话
        <span className="kbd">⌘N</span>
      </button>
      <div className="sb-search">
        <Icon name="search" />
        <input placeholder="搜索会话 / 项目…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {(onDiagnostics || onAnalytics || onSkills || onMcp) && (
        <nav className="sb-nav" aria-label="主要视图">
          {onAnalytics && (
            <button
              type="button"
              className={`sb-navitem ${analyticsActive ? 'active' : ''}`}
              aria-current={analyticsActive ? 'page' : undefined}
              onClick={onAnalytics}
            >
              <Icon name="chart" /> 分析
            </button>
          )}
          {onDiagnostics && (
            <button
              type="button"
              className={`sb-navitem ${diagnosticsActive ? 'active' : ''}`}
              aria-current={diagnosticsActive ? 'page' : undefined}
              onClick={onDiagnostics}
            >
              <Icon name="info" /> 诊断
            </button>
          )}
          {onSkills && (
            <button type="button" className="sb-navitem" onClick={onSkills} title="Skills" aria-haspopup="dialog">
              <Icon name="box" /> 技能
              {skillCount != null && skillCount > 0 && <span className="sb-navmeta">{skillCount}</span>}
            </button>
          )}
          {onMcp && (
            <button
              type="button"
              className="sb-navitem"
              onClick={onMcp}
              title="MCP"
              aria-haspopup="dialog"
              aria-label={`MCP · ${mcpSummary.label}`}
            >
              <Icon name="cube" /> MCP
              <span className="sb-navmeta" aria-hidden="true">
                <span className={`sb-navdot ${mcpSummary.tone}`} />
                {mcpSummary.total > 0 && <span>{mcpSummary.connected}/{mcpSummary.total}</span>}
              </span>
            </button>
          )}
        </nav>
      )}

      <div className="sb-section">
        最近 <span className="cnt">{filtered.length}</span>
      </div>
      <div className="sb-list">
        {catalogHealth && catalogHealth.status !== 'ready' && (
          <div className="sb-empty" role="status" title={catalogHealth.reason}>
            {catalogHealth.status === 'degraded'
              ? '会话索引已从备份恢复；下一次成功写入会修复主索引。'
              : '会话索引不可用；请检查 app-sessions.json 与 .bak 后重试。'}
          </div>
        )}
        {filtered.length === 0 && <div className="sb-empty">无历史会话</div>}
        {filtered.map((p) => {
          const open = !collapsed.has(p.cwd)
          const active = p.cwd ? p.cwd === activeCwd : activeCwd == null
          const contextLabel = p.cwd || '未关联工作目录'
          return (
            <div key={p.cwd} className={`sb-proj ${open ? 'open' : ''}`}>
              <button
                type="button"
                className={`sb-proj-head ${active ? 'on' : ''}`}
                title={`${p.name}\n${contextLabel}`}
                aria-label={`${p.name} · ${contextLabel}`}
                aria-expanded={open}
                data-project-path={p.cwd}
                onClick={() => toggle(p.cwd)}
              >
                <Icon name="chevronRight" className="chev" />
                <span className="pname">{p.name}</span>
                <span className="ppath" aria-hidden="true">
                  {p.cwd}
                </span>
                <span className="pcnt">{p.sessions.length}</span>
              </button>
              {open && (
                <div className="sb-sess-list">
                  {p.sessions.map((s) => {
                    const active = s.sessionId === activeSessionId && s.providerId === activeProviderId
                    const running = Boolean(s.runId && runningRunIds.has(s.runId))
                    return (
                      <button
                        type="button"
                        key={`${s.providerId}:${s.sessionId}`}
                        className={['sb-sess', active && 'active', running && 'running'].filter(Boolean).join(' ')}
                        title={`${s.preview}${s.preview ? '\n' : ''}${activeTimeTitle(s.mtime)}${running ? '\n正在运行' : ''}`}
                        aria-current={active ? 'true' : undefined}
                        aria-haspopup="menu"
                        onClick={() => onPick(p.cwd, s.sessionId, s.providerId, s.externalSessionId, s.runId)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          const rect = e.currentTarget.getBoundingClientRect()
                          setCtx({
                            x: e.clientX || rect.left + 8,
                            y: e.clientY || rect.top + 8,
                            cwd: p.cwd,
                            sessionId: s.sessionId,
                            providerId: s.providerId,
                            externalSessionId: s.externalSessionId,
                            opener: e.currentTarget
                          })
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
                          e.preventDefault()
                          const rect = e.currentTarget.getBoundingClientRect()
                          setCtx({
                            x: rect.left + 8,
                            y: rect.top + 8,
                            cwd: p.cwd,
                            sessionId: s.sessionId,
                            providerId: s.providerId,
                            externalSessionId: s.externalSessionId,
                            opener: e.currentTarget
                          })
                        }}
                      >
                        <span className="sb-session-main">
                          <span className="sb-provider">{s.providerId === 'legacy_unknown' ? '历史?' : s.providerId}</span>
                          <span className="sb-sesstext">{s.preview || '(无预览)'}</span>
                        </span>
                        <span className="sb-session-meta">
                          {s.count > 1 && <span className="sb-count">{s.count} 轮</span>}
                          <span className="sb-sesstime" title={activeTimeTitle(s.mtime)}>
                            {relTime(s.mtime)}
                          </span>
                        </span>
                        {running && <span className="sb-running" role="status" aria-label="正在运行" />}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {onSettings && (
        <div className="sb-footer">
          <button type="button" className="sb-navitem sb-settings" onClick={onSettings} aria-haspopup="dialog">
            <Icon name="settings" /> 设置
            <span className="sb-navmeta">{themeLabel}</span>
          </button>
        </div>
      )}

      {ctx && (
        <div
          className="ctx-overlay"
          onClick={closeContextMenu}
          onContextMenu={(e) => {
            e.preventDefault()
            closeContextMenu()
          }}
        >
          <div
            className="ctxmenu"
            role="menu"
            aria-label="会话操作"
            style={{ left: ctx.x, top: ctx.y }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              closeContextMenu()
            }}
          >
            <button
              ref={contextActionRef}
              type="button"
              role="menuitem"
              className="ctxitem del"
              onClick={() => {
                onDelete(ctx.cwd, ctx.sessionId, ctx.providerId, ctx.externalSessionId)
                closeContextMenu()
              }}
            >
              <Icon name="x" /> 删除会话
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}

function summarizeMcpNav(mcps: McpMeta[], live: McpLiveStatus[]): {
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
