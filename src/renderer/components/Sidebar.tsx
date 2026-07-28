// 左侧栏（蓝本 welcome/chat 通用）：brand+版本 / 新建会话 / 搜索 / 按工作目录分组的历史会话（右键删除）/ 底部 Skills·MCP。
import { useState } from 'react'
import { relTime } from '../format'
import { Icon } from './primitives/Icon'
import type { ProjectMeta } from '../env'
import type { SessionProviderId } from '@shared/provider'

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
  skillCount,
  mcpOnline,
  mcpTotal,
  onNewChat,
  onPick,
  onSkills,
  onMcp,
  onDelete,
  onDiagnostics,
  diagnosticsActive = false,
  onAnalytics,
  analyticsActive = false
}: {
  id?: string
  projects: ProjectMeta[]
  activeCwd: string | null
  activeSessionId?: string | null
  activeProviderId?: SessionProviderId
  runningRunIds?: ReadonlySet<string>
  version?: string
  skillCount?: number
  mcpOnline?: number
  mcpTotal?: number
  onNewChat: () => void
  onPick: (cwd: string, sessionId: string, providerId: SessionProviderId, externalSessionId?: string, runId?: string) => void
  onSkills: () => void
  onMcp: () => void
  onDelete: (cwd: string, sessionId: string, providerId: SessionProviderId, externalSessionId?: string) => void
  onDiagnostics?: () => void
  diagnosticsActive?: boolean
  onAnalytics?: () => void
  analyticsActive?: boolean
}) {
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [ctx, setCtx] = useState<{
    x: number
    y: number
    cwd: string
    sessionId: string
    providerId: SessionProviderId
    externalSessionId?: string
  } | null>(null)
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
  return (
    <aside className="sidebar" id={id}>
      <div className="sb-brand">
        <span className="logo">a</span>
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

      {(onDiagnostics || onAnalytics) && (
        <div className="sb-nav">
          {onAnalytics && (
            <div className={`sb-navitem ${analyticsActive ? 'active' : ''}`} onClick={onAnalytics}>
              <Icon name="chart" /> 分析
            </div>
          )}
          {onDiagnostics && (
            <div className={`sb-navitem ${diagnosticsActive ? 'active' : ''}`} onClick={onDiagnostics}>
              <Icon name="info" /> 诊断
            </div>
          )}
        </div>
      )}

      <div className="sb-section">
        最近 <span className="cnt">{filtered.length}</span>
      </div>
      <div className="sb-list">
        {filtered.length === 0 && <div className="sb-empty">无历史会话</div>}
        {filtered.map((p) => {
          const open = !collapsed.has(p.cwd)
          return (
            <div key={p.cwd} className={`sb-proj ${open ? 'open' : ''}`}>
              <div
                className={`sb-proj-head ${p.cwd === activeCwd ? 'on' : ''}`}
                title={`${p.name}\n${p.cwd}`}
                aria-label={`${p.name} · ${p.cwd}`}
                data-project-path={p.cwd}
                onClick={() => toggle(p.cwd)}
              >
                <Icon name="chevronRight" className="chev" />
                <span className="pname">{p.name}</span>
                <span className="ppath" aria-hidden="true">
                  {p.cwd}
                </span>
                <span className="pcnt">{p.sessions.length}</span>
              </div>
              {open && (
                <div className="sb-sess-list">
                  {p.sessions.map((s) => {
                    const active = s.sessionId === activeSessionId && s.providerId === activeProviderId
                    const running = Boolean(s.runId && runningRunIds.has(s.runId))
                    return (
                      <div
                        key={`${s.providerId}:${s.sessionId}`}
                        className={['sb-sess', active && 'active', running && 'running'].filter(Boolean).join(' ')}
                        title={`${s.preview}${s.preview ? '\n' : ''}${activeTimeTitle(s.mtime)}${running ? '\n正在运行' : ''}`}
                        onClick={() => onPick(p.cwd, s.sessionId, s.providerId, s.externalSessionId, s.runId)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setCtx({
                            x: e.clientX,
                            y: e.clientY,
                            cwd: p.cwd,
                            sessionId: s.sessionId,
                            providerId: s.providerId,
                            externalSessionId: s.externalSessionId
                          })
                        }}
                      >
                        <span className="sb-sesstext">
                          <span className="sb-provider">{s.providerId === 'legacy_unknown' ? '历史?' : s.providerId}</span>
                          {s.preview || '(无预览)'}
                          {s.count > 1 && <span className="sb-count"> ×{s.count}</span>}
                        </span>
                        <span className="sb-sesstime" title={activeTimeTitle(s.mtime)}>
                          活跃 {relTime(s.mtime)}
                        </span>
                        {running && <span className="sb-running" role="status" aria-label="正在运行" />}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="sb-foot">
        <button className="sb-tool" onClick={onSkills}>
          <Icon name="box" /> 技能
          {skillCount != null && skillCount > 0 && <span className="cnt">{skillCount}</span>}
        </button>
        <button className="sb-tool" onClick={onMcp}>
          <span className="dot" /> MCP
          {mcpTotal != null && mcpTotal > 0 && (
            <span className="cnt">
              {mcpOnline ?? 0}/{mcpTotal}
            </span>
          )}
        </button>
      </div>

      {ctx && (
        <div
          className="ctx-overlay"
          onClick={() => setCtx(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setCtx(null)
          }}
        >
          <div className="ctxmenu" style={{ left: ctx.x, top: ctx.y }}>
            <div
              className="ctxitem del"
              onClick={() => {
                onDelete(ctx.cwd, ctx.sessionId, ctx.providerId, ctx.externalSessionId)
                setCtx(null)
              }}
            >
              <Icon name="x" /> 删除会话
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
