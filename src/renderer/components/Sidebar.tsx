// 左侧栏（蓝本 welcome/chat 通用）：brand+版本 / 新建会话 / 搜索 / 置顶分组 / 按工作目录分组的历史会话。
// 会话行的置顶与存档是行内 hover 按钮；删除只在设置的「已存档会话」里发生，这里没有删除入口。
import { useState } from 'react'
import { relTime } from '../format'
import { Icon } from './primitives/Icon'
import type { ProjectMeta, SessionMeta } from '../env'
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

const sessionKey = (session: SessionMeta): string =>
  `${session.providerId}:${session.agentProfileId ?? ''}:${session.sessionId}`

export function Sidebar({
  id,
  projects,
  activeCwd,
  activeSessionId = null,
  activeProviderId,
  activeAgentProfileId,
  runningRunIds = new Set<string>(),
  version = '0.1.0',
  onNewChat,
  onPick,
  onTogglePin,
  onArchive,
  archiveUndo = null,
  onUndoArchive,
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
  activeAgentProfileId?: string
  runningRunIds?: ReadonlySet<string>
  version?: string
  onNewChat: () => void
  onPick: (cwd: string, sessionId: string, providerId: SessionProviderId, externalSessionId?: string, runId?: string, agentProfileId?: string) => void
  onTogglePin: (cwd: string, session: SessionMeta) => void
  onArchive: (cwd: string, session: SessionMeta) => void
  archiveUndo?: { preview: string } | null
  onUndoArchive?: () => void
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
  const toggle = (cwd: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(cwd) ? next.delete(cwd) : next.add(cwd)
      return next
    })
  const ql = q.trim().toLowerCase()
  const matches = (session: SessionMeta): boolean => !ql || session.preview.toLowerCase().includes(ql)
  // 置顶会话跨项目平铺，从原项目分组里移出；行内带项目名，避免丢掉工作目录上下文。
  const pinned = projects
    .flatMap((project) => project.sessions
      .filter((session) => session.pinnedAt && matches(session))
      .map((session) => ({ session, cwd: project.cwd, name: project.name })))
    .sort((a, b) => (b.session.pinnedAt ?? 0) - (a.session.pinnedAt ?? 0))
  const filtered = projects
    .map((project) => ({ ...project, sessions: project.sessions.filter((session) => !session.pinnedAt && matches(session)) }))
    .filter((project) => project.sessions.length > 0)
  const mcpSummary = summarizeMcpNav(mcps, mcpLive)
  const isActive = (session: SessionMeta): boolean =>
    session.sessionId === activeSessionId && session.providerId === activeProviderId &&
    session.agentProfileId === activeAgentProfileId
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

      <div className="sb-list">
        {catalogHealth && catalogHealth.status !== 'ready' && (
          <div className="sb-empty" role="status" title={catalogHealth.reason}>
            {catalogHealth.status === 'degraded'
              ? '会话索引已从备份恢复；下一次成功写入会修复主索引。'
              : '会话索引不可用；请检查 app-sessions.json 与 .bak 后重试。'}
          </div>
        )}
        {pinned.length > 0 && (
          <>
            <div className="sb-section">
              置顶 <span className="cnt">{pinned.length}</span>
            </div>
            <div className="sb-pinned">
              {pinned.map(({ session, cwd, name }) => (
                <SessionRow
                  key={sessionKey(session)}
                  session={session}
                  cwd={cwd}
                  projectName={name}
                  active={isActive(session)}
                  running={Boolean(session.runId && runningRunIds.has(session.runId))}
                  onPick={onPick}
                  onTogglePin={onTogglePin}
                  onArchive={onArchive}
                />
              ))}
            </div>
            <div className="sb-divider" />
          </>
        )}
        <div className="sb-section">
          最近 <span className="cnt">{filtered.length}</span>
        </div>
        {filtered.length === 0 && pinned.length === 0 && <div className="sb-empty">无历史会话</div>}
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
                {p.cwd && (
                  <span className="ppath" aria-hidden="true">
                    {p.cwd}
                  </span>
                )}
                <span className="pcnt">{p.sessions.length}</span>
              </button>
              {open && (
                <div className="sb-sess-list">
                  {p.sessions.map((s) => (
                    <SessionRow
                      key={sessionKey(s)}
                      session={s}
                      cwd={p.cwd}
                      active={isActive(s)}
                      running={Boolean(s.runId && runningRunIds.has(s.runId))}
                      onPick={onPick}
                      onTogglePin={onTogglePin}
                      onArchive={onArchive}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {archiveUndo && onUndoArchive && (
        <div className="sb-undo" role="status">
          <span>已存档「{archiveUndo.preview || '(无预览)'}」</span>
          <button type="button" onClick={onUndoArchive}>
            <Icon name="undo" /> 撤销
          </button>
        </div>
      )}

      {onSettings && (
        <div className="sb-footer">
          <button type="button" className="sb-navitem sb-settings" onClick={onSettings} aria-haspopup="dialog">
            <Icon name="settings" /> 设置
            <span className="sb-navmeta">{themeLabel}</span>
          </button>
        </div>
      )}
    </aside>
  )
}

// 行是 wrapper + 内部 button：会话按钮里不能再嵌按钮，操作区必须是它的兄弟节点。
function SessionRow({
  session,
  cwd,
  projectName,
  active,
  running,
  onPick,
  onTogglePin,
  onArchive
}: {
  session: SessionMeta
  cwd: string
  projectName?: string
  active: boolean
  running: boolean
  onPick: (cwd: string, sessionId: string, providerId: SessionProviderId, externalSessionId?: string, runId?: string, agentProfileId?: string) => void
  onTogglePin: (cwd: string, session: SessionMeta) => void
  onArchive: (cwd: string, session: SessionMeta) => void
}) {
  const pinned = Boolean(session.pinnedAt)
  return (
    <div className="sb-sess-row">
      <button
        type="button"
        className={['sb-sess', active && 'active', running && 'running'].filter(Boolean).join(' ')}
        data-provider={session.providerId}
        title={`${session.preview}${session.preview ? '\n' : ''}${activeTimeTitle(session.mtime)}${running ? '\n正在运行' : ''}`}
        aria-current={active ? 'true' : undefined}
        onClick={() => onPick(cwd, session.sessionId, session.providerId, session.externalSessionId, session.runId, session.agentProfileId)}
      >
        <span className="sb-session-main">
          <span className="sb-provider">{session.providerId === 'legacy_unknown' ? '历史?' : session.providerId}</span>
          <span className="sb-sesstext">{session.preview || '(无预览)'}</span>
        </span>
        <span className="sb-session-meta">
          {session.count > 1 && <span className="sb-count">{session.count} 轮</span>}
          <span className="sb-sesstime" title={activeTimeTitle(session.mtime)}>
            {relTime(session.mtime)}
          </span>
          {projectName && <span className="sb-sess-proj">{projectName}</span>}
        </span>
        {running && <span className="sb-running" role="status" aria-label="正在运行" />}
      </button>
      <span className="sb-sess-acts">
        <button
          type="button"
          className={`sb-act ${pinned ? 'on' : ''}`}
          title={pinned ? '取消置顶' : '置顶会话'}
          aria-label={pinned ? `取消置顶：${session.preview || '(无预览)'}` : `置顶会话：${session.preview || '(无预览)'}`}
          aria-pressed={pinned}
          onClick={() => onTogglePin(cwd, session)}
        >
          <Icon name="pin" />
        </button>
        <button
          type="button"
          className="sb-act"
          title="存档会话"
          aria-label={`存档会话：${session.preview || '(无预览)'}`}
          onClick={() => onArchive(cwd, session)}
        >
          <Icon name="archive" />
        </button>
      </span>
    </div>
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
