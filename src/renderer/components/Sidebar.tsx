// 左侧栏（蓝本 welcome/chat 通用）：brand+版本 / 新建会话 / 搜索 / 置顶分组 / 按工作目录分组的历史会话。
// 会话行的置顶与存档是行内 hover 按钮；删除只在设置的「已存档会话」里发生，这里没有删除入口。
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { relTime } from '../format'
import type { BackgroundWork } from '@shared/background-work'
import { sessionAttentionKey } from '@shared/session-attention'
import { backgroundWorkStatus } from '../background-work-status'
import { Icon } from './primitives/Icon'
import { ModalFrame } from './Modals'
import type { ProjectMeta, SessionMeta } from '../env'
import type { SessionProviderId } from '@shared/provider'
import type { CatalogHealth } from '@shared/provider'
import { sessionMatchesSelection } from '../session-selection'
import { SessionRenameMenu, type SessionMenuTarget } from './SessionRename'
import { SessionHoverProvider, useSessionHoverCard } from './SessionHoverCard'
import { ProviderGlyph } from './ProviderGlyph'
import type { RemoteSessionRef } from '@shared/desktop-remote'
import { useDesktopConnections } from '../hooks/useDesktopConnections'
import { SidebarRemoteProjects, useRemoteProjectGroups, type ActiveRemoteLocation } from './SidebarRemoteProjects'

const sessionKey = (cwd: string, session: SessionMeta): string =>
  `${cwd}:${session.providerId}:${session.agentProfileId ?? ''}:${session.sessionId}`

// 会话行的 Provider 身份用真实品牌字形呈现（见 codex-alignment.css 的 .sb-provider mask）；
// 这里保留可访问名，legacy_unknown 无品牌，仍用「历史?」文字。
const providerDisplayName: Record<SessionProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  qoder: 'Qoder',
  opencode: 'OpenCode',
  pi: 'Pi',
  legacy_unknown: '历史会话'
}

export const Sidebar = memo(function Sidebar({
  id,
  projects,
  activeCwd,
  activeSessionId = null,
  activeProviderId,
  activeAgentProfileId,
  runningRunIds = new Set<string>(),
  waitingQuestionRunIds = new Set<string>(),
  unreadSessionKeys = new Set<string>(),
  backgroundWorkByRun = {},
  version = '0.1.0',
  onNewChat,
  onPick,
  onTogglePin,
  onArchive,
  onRenameSession,
  onNewProjectChat,
  onToggleProjectPin,
  onRenameProject,
  onRemoveProject,
  onRevealProject,
  archiveUndo = null,
  onUndoArchive,
  onAnalytics,
  analyticsActive = false,
  onLlmPerformance,
  onSkills,
  onMcp,
  onMetaPrompts,
  metaPromptsActive = false,
  catalogHealth,
  onSettings,
  onHosts,
  hostsActive = false,
  activeRemote = null,
  onPickRemoteSession,
  onNewRemoteProjectChat
}: {
  id?: string
  projects: ProjectMeta[]
  activeCwd: string | null
  activeSessionId?: string | null
  activeProviderId?: SessionProviderId
  activeAgentProfileId?: string
  runningRunIds?: ReadonlySet<string>
  waitingQuestionRunIds?: ReadonlySet<string>
  unreadSessionKeys?: ReadonlySet<string>
  backgroundWorkByRun?: Readonly<Record<string, BackgroundWork>>
  version?: string
  onNewChat: () => void
  onPick: (cwd: string, sessionId: string, providerId: SessionProviderId, externalSessionId?: string, runId?: string, agentProfileId?: string) => void
  onTogglePin: (cwd: string, session: SessionMeta) => void
  onArchive: (cwd: string, session: SessionMeta) => void
  onRenameSession?: (cwd: string, session: SessionMeta, title: string) => Promise<void>
  onNewProjectChat?: (cwd: string) => void
  onToggleProjectPin?: (project: ProjectMeta) => void
  onRenameProject?: (project: ProjectMeta, name: string) => void | Promise<void>
  onRemoveProject?: (project: ProjectMeta) => void | Promise<void>
  onRevealProject?: (project: ProjectMeta) => void
  archiveUndo?: { preview: string } | null
  onUndoArchive?: () => void
  onAnalytics?: () => void
  analyticsActive?: boolean
  onLlmPerformance?: () => void
  onSkills?: () => void
  onMcp?: () => void
  onMetaPrompts?: () => void
  metaPromptsActive?: boolean
  catalogHealth?: CatalogHealth
  onSettings?: () => void
  onHosts?: () => void
  hostsActive?: boolean
  activeRemote?: ActiveRemoteLocation | null
  onPickRemoteSession?: (connectionId: string, session: RemoteSessionRef) => void
  onNewRemoteProjectChat?: (connectionId: string, cwd: string) => void
}) {
  const [sessionMenu, setSessionMenu] = useState<SessionMenuTarget | null>(null)
  const openSessionMenu = (event: ReactMouseEvent<HTMLButtonElement>, cwd: string, session: SessionMeta): void => {
    event.preventDefault()
    setProjectMenu(null)
    const rect = event.currentTarget.getBoundingClientRect()
    const context = event.type === 'contextmenu' && (event.clientX !== 0 || event.clientY !== 0)
    setSessionMenu({
      cwd, session, trigger: event.currentTarget,
      left: Math.max(8, Math.min(context ? event.clientX : rect.left, window.innerWidth - 208)),
      top: Math.max(8, Math.min(context ? event.clientY : rect.bottom, window.innerHeight - 64))
    })
  }
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [projectMenu, setProjectMenu] = useState<{ project: ProjectMeta; left: number; top: number } | null>(null)
  const [projectDialog, setProjectDialog] = useState<{ mode: 'rename' | 'remove'; project: ProjectMeta } | null>(null)
  const projectMenuRef = useRef<HTMLDivElement>(null)
  const toggle = (cwd: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(cwd) ? next.delete(cwd) : next.add(cwd)
      return next
    })
  useEffect(() => {
    if (!projectMenu) return
    const dismissPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !projectMenuRef.current?.contains(event.target)) setProjectMenu(null)
    }
    const dismissEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setProjectMenu(null)
    }
    document.addEventListener('pointerdown', dismissPointer, true)
    document.addEventListener('keydown', dismissEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissPointer, true)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [projectMenu])
  const ql = q.trim().toLowerCase()
  const remoteGroups = useRemoteProjectGroups(q)
  const showRemote = Boolean(onPickRemoteSession && onNewRemoteProjectChat) && remoteGroups.length > 0
  const { pinned, filtered } = useMemo(() => {
    const matches = (session: SessionMeta): boolean => !ql || session.preview.toLowerCase().includes(ql)
    // 置顶会话跨项目平铺，从原项目分组里移出；行内带项目名。
    const pinned = projects
      .flatMap((project) => project.sessions
        .filter((session) => session.pinnedAt && matches(session))
        .map((session) => ({ session, cwd: project.cwd, name: project.name })))
      .sort((a, b) => (b.session.pinnedAt ?? 0) - (a.session.pinnedAt ?? 0))
    const filtered = projects
      .map((project) => ({
        ...project,
        totalSessions: project.sessions.length,
        projectMatch: !ql || project.name.toLowerCase().includes(ql) || project.cwd.toLowerCase().includes(ql),
        sessions: project.sessions.filter((session) => !session.pinnedAt && matches(session))
      }))
      .filter((project) => project.projectMatch || project.sessions.length > 0)
    return { pinned, filtered }
  }, [projects, ql])
  const isActive = (cwd: string, session: SessionMeta): boolean => sessionMatchesSelection(cwd, session, {
    cwd: activeCwd,
    sessionId: activeSessionId,
    providerId: activeProviderId,
    agentProfileId: activeAgentProfileId
  })
  const openProjectMenu = (event: ReactMouseEvent<HTMLButtonElement>, project: ProjectMeta): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setProjectMenu({
      project,
      left: Math.min(rect.right + 6, window.innerWidth - 254),
      top: Math.max(8, Math.min(rect.top - 8, window.innerHeight - 292))
    })
  }
  return (
    <aside className="sidebar" id={id} aria-label="会话导航">
      <div className="sb-brand">
        <span className="name">Scry</span>
        <span className="ver">{version}</span>
      </div>
      <button className="sb-new" onClick={onNewChat}>
        <Icon name="plus" /> 新建会话
      </button>
      <div className="sb-search">
        <Icon name="search" />
        <input placeholder="搜索会话 / 项目…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {(onAnalytics || onLlmPerformance || onSkills || onMcp || onMetaPrompts || onHosts) && (
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
            <button
              type="button"
              className="sb-navitem"
              onClick={onMcp}
              title="MCP"
              aria-haspopup="dialog"
              aria-label="MCP"
            >
              <Icon name="cube" /> MCP
            </button>
          )}
          {onMetaPrompts && (
            <button
              type="button"
              className={`sb-navitem ${metaPromptsActive ? 'active' : ''}`}
              aria-current={metaPromptsActive ? 'page' : undefined}
              onClick={onMetaPrompts}
            >
              <Icon name="terminal" /> Meta Prompts
            </button>
          )}
          {onHosts && <HostsNavItem active={hostsActive} onClick={onHosts} />}
        </nav>
      )}

      <SessionHoverProvider><div className="sb-list">
        {catalogHealth && catalogHealth.status !== 'ready' && (
          <div className="sb-empty" role="status" title={catalogHealth.reason}>
            {catalogHealth.status === 'degraded'
              ? '会话索引已从备份恢复；下一次成功写入会修复主索引。'
              : '会话索引不可用；请检查 app-sessions.json 与 .bak 后重试。'}
          </div>
        )}
        {pinned.length > 0 && (
          <>
            <div className="sb-section">置顶</div>
            <div className="sb-pinned">
              {pinned.map(({ session, cwd, name }) => (
                <SessionRow
                  key={sessionKey(cwd, session)}
                  session={session}
                  cwd={cwd}
                  projectName={name}
                  showProjectName
                  active={isActive(cwd, session)}
                  running={Boolean(session.runId && runningRunIds.has(session.runId))}
                  waitingForAnswer={Boolean(session.runId && waitingQuestionRunIds.has(session.runId))}
                  unread={unreadSessionKeys.has(sessionAttentionKey({
                    providerId: session.providerId,
                    agentProfileId: session.agentProfileId,
                    cwd,
                    sessionId: session.externalSessionId ?? session.sessionId
                  }))}
                  backgroundWork={session.runId ? backgroundWorkByRun[session.runId] : undefined}
                  onPick={onPick}
                  onTogglePin={onTogglePin}
                  onArchive={onArchive}
                  onMenu={onRenameSession ? openSessionMenu : undefined}
                />
              ))}
            </div>
            <div className="sb-divider" />
          </>
        )}
        <div className="sb-section sb-project-section">项目</div>
        {filtered.length === 0 && pinned.length === 0 && !showRemote && (
          <div className="sb-empty">{projects.length === 0 ? '暂无项目' : '无匹配项目或会话'}</div>
        )}
        {filtered.map((p) => {
          const open = !collapsed.has(p.cwd)
          const active = p.cwd ? p.cwd === activeCwd : activeCwd == null
          const projectSelected = active && activeSessionId == null
          const emptyLabel = p.totalSessions === 0 ? '暂无会话' : ql ? '无匹配会话' : '会话已置顶'
          return (
            <div key={p.cwd} className={`sb-proj ${open ? 'open' : ''}`}>
              <div className={`sb-proj-row ${projectSelected ? 'active' : ''}`}>
                <button
                  type="button"
                  className={`sb-proj-head ${projectSelected ? 'on' : ''}`}
                  aria-label={p.cwd ? `${p.name} · ${p.cwd}` : `${p.name} · 未关联工作目录`}
                  aria-expanded={open}
                  data-project-path={p.cwd}
                  onClick={() => toggle(p.cwd)}
                >
                  <Icon name="folder" className="sb-project-folder" />
                  <span className="pname">{p.name}</span>
                  {p.pinnedAt && <Icon name="pin" className="sb-project-pin" />}
                </button>
                {p.cwd && onNewProjectChat && (
                  <span className="sb-proj-acts">
                    <button
                      type="button"
                      className="sb-proj-act sb-proj-new"
                      title={`在 ${p.name} 中新建会话`}
                      aria-label={`在 ${p.name} 中新建会话 · ${p.cwd}`}
                      onClick={() => onNewProjectChat(p.cwd)}
                    >
                      <Icon name="plus" />
                    </button>
                    <button
                      type="button"
                      className="sb-proj-act sb-proj-more"
                      title={`管理项目 ${p.name}`}
                      aria-label={`管理项目 ${p.name} · ${p.cwd}`}
                      onClick={(event) => openProjectMenu(event, p)}
                    >
                      ···
                    </button>
                  </span>
                )}
              </div>
              {open && (
                <div className="sb-sess-list">
                  {p.sessions.map((s) => (
                    <SessionRow
                      key={sessionKey(p.cwd, s)}
                      session={s}
                      cwd={p.cwd}
                      projectName={p.name}
                      active={isActive(p.cwd, s)}
                      running={Boolean(s.runId && runningRunIds.has(s.runId))}
                      waitingForAnswer={Boolean(s.runId && waitingQuestionRunIds.has(s.runId))}
                      unread={unreadSessionKeys.has(sessionAttentionKey({
                        providerId: s.providerId,
                        agentProfileId: s.agentProfileId,
                        cwd: p.cwd,
                        sessionId: s.externalSessionId ?? s.sessionId
                      }))}
                      backgroundWork={s.runId ? backgroundWorkByRun[s.runId] : undefined}
                      onPick={onPick}
                      onTogglePin={onTogglePin}
                      onArchive={onArchive}
                      onMenu={onRenameSession ? openSessionMenu : undefined}
                    />
                  ))}
                  {p.sessions.length === 0 && (
                    <div className="sb-project-empty">{emptyLabel}</div>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {showRemote && onPickRemoteSession && onNewRemoteProjectChat && (
          <SidebarRemoteProjects
            groups={remoteGroups}
            active={activeRemote}
            onPickSession={onPickRemoteSession}
            onNewProjectChat={onNewRemoteProjectChat}
          />
        )}
      </div></SessionHoverProvider>

      {sessionMenu && onRenameSession && (
        <SessionRenameMenu target={sessionMenu} onRename={onRenameSession} onClose={() => {
          const trigger = sessionMenu.trigger
          setSessionMenu(null)
          window.requestAnimationFrame(() => { if (trigger.isConnected) trigger.focus() })
        }} />
      )}

      {projectMenu && (
        <div
          ref={projectMenuRef}
          className="menu sb-project-menu"
          role="menu"
          aria-label={`管理项目 ${projectMenu.project.name}`}
          style={{ left: projectMenu.left, top: projectMenu.top }}
        >
          <div className="sb-project-menu-head">
            <b>{projectMenu.project.name}</b>
            <code>{projectMenu.project.cwd}</code>
          </div>
          {onNewProjectChat && (
            <button type="button" className="mitem on" onClick={() => { setProjectMenu(null); onNewProjectChat(projectMenu.project.cwd) }}>
              <Icon name="plus" /> 在此项目新建会话
            </button>
          )}
          <div className="mdiv" />
          {onToggleProjectPin && (
            <button type="button" className="mitem" onClick={() => { setProjectMenu(null); onToggleProjectPin(projectMenu.project) }}>
              <Icon name="pin" /> {projectMenu.project.pinnedAt ? '取消置顶项目' : '置顶项目'}
            </button>
          )}
          {onRevealProject && (
            <button type="button" className="mitem" onClick={() => { setProjectMenu(null); onRevealProject(projectMenu.project) }}>
              <Icon name="folder" /> 在 Finder 中显示
            </button>
          )}
          {onRenameProject && (
            <button type="button" className="mitem" onClick={() => { setProjectDialog({ mode: 'rename', project: projectMenu.project }); setProjectMenu(null) }}>
              <Icon name="settings" /> 编辑项目名称
            </button>
          )}
          <div className="mdiv" />
          {onRemoveProject && (
            <button type="button" className="mitem sb-project-remove" onClick={() => { setProjectDialog({ mode: 'remove', project: projectMenu.project }); setProjectMenu(null) }}>
              <Icon name="x" /> 从 Scry 移除项目
            </button>
          )}
        </div>
      )}

      {projectDialog && (
        <ProjectDialog
          key={`${projectDialog.mode}:${projectDialog.project.cwd}`}
          mode={projectDialog.mode}
          project={projectDialog.project}
          onClose={() => setProjectDialog(null)}
          onRename={async (name) => {
            await onRenameProject?.(projectDialog.project, name)
            setProjectDialog(null)
          }}
          onRemove={async () => {
            await onRemoveProject?.(projectDialog.project)
            setProjectDialog(null)
          }}
        />
      )}

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
          </button>
        </div>
      )}
    </aside>
  )
})

function ProjectDialog({
  mode,
  project,
  onClose,
  onRename,
  onRemove
}: {
  mode: 'rename' | 'remove'
  project: ProjectMeta
  onClose: () => void
  onRename: (name: string) => void | Promise<void>
  onRemove: () => void | Promise<void>
}) {
  const [name, setName] = useState(project.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = `project-dialog-${mode}`
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={mode === 'rename' ? inputRef : undefined} className="project-dialog" onClose={onClose}>
      <div className="modal-head">
        <b id={titleId}>{mode === 'rename' ? '编辑项目名称' : `移除“${project.name}”？`}</b>
        <button type="button" className="modal-x" aria-label="关闭" onClick={onClose}>×</button>
      </div>
      {mode === 'rename' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const next = name.trim()
            if (next) void onRename(next)
          }}
        >
          <div className="project-dialog-body">
            <label>
              <span>显示名称</span>
              <input ref={inputRef} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
            </label>
            <code>{project.cwd}</code>
          </div>
          <div className="project-dialog-actions">
            <button type="button" className="btn" onClick={onClose}>取消</button>
            <button type="submit" className="btn primary" disabled={!name.trim()}>保存</button>
          </div>
        </form>
      ) : (
        <>
          <div className="project-dialog-body">
            <p>只会移除 Scry 中的项目入口，不会删除目录、Git 仓库、会话历史或分析数据。</p>
            <code>{project.cwd}</code>
          </div>
          <div className="project-dialog-actions">
            <button type="button" className="btn" onClick={onClose}>取消</button>
            <button type="button" className="btn project-remove-confirm" onClick={() => void onRemove()}>移除项目</button>
          </div>
        </>
      )}
    </ModalFrame>
  )
}

// 行是 wrapper + 内部 button：会话按钮里不能再嵌按钮，操作区必须是它的兄弟节点。
function SessionRow({
  session,
  cwd,
  projectName,
  showProjectName = false,
  active,
  running,
  waitingForAnswer,
  unread,
  backgroundWork,
  onPick,
  onTogglePin,
  onArchive,
  onMenu
}: {
  session: SessionMeta
  cwd: string
  projectName?: string
  showProjectName?: boolean
  active: boolean
  running: boolean
  waitingForAnswer: boolean
  unread: boolean
  backgroundWork?: BackgroundWork
  onPick: (cwd: string, sessionId: string, providerId: SessionProviderId, externalSessionId?: string, runId?: string, agentProfileId?: string) => void
  onTogglePin: (cwd: string, session: SessionMeta) => void
  onArchive: (cwd: string, session: SessionMeta) => void
  onMenu?: (event: ReactMouseEvent<HTMLButtonElement>, cwd: string, session: SessionMeta) => void
}) {
  const pinned = Boolean(session.pinnedAt)
  const status = running ? backgroundWorkStatus(backgroundWork) : undefined
  const hover = useSessionHoverCard(session, cwd, projectName, running, status?.label)
  return (
    <div className="sb-sess-row">
      <button
        type="button"
        className={['sb-sess', active && 'active', running && 'running', waitingForAnswer && 'waiting-answer', unread && 'unread'].filter(Boolean).join(' ')}
        data-provider={session.providerId}
        {...hover.triggerProps}
        aria-current={active ? 'true' : undefined}
        onContextMenu={onMenu ? (event) => { hover.dismiss(); onMenu(event, cwd, session) } : undefined}
        onClick={() => {
          hover.dismiss()
          onPick(
            cwd,
            session.sessionId,
            session.providerId,
            session.externalSessionId,
            running ? session.runId : undefined,
            session.agentProfileId
          )
        }}
      >
        <span className="sb-session-main">
          {session.providerId === 'legacy_unknown' ? (
            <span className="sb-provider" data-provider="legacy_unknown">历史?</span>
          ) : (
            <ProviderGlyph
              className="sb-provider"
              provider={session.providerId}
              label={providerDisplayName[session.providerId]}
            />
          )}
          <span className="sb-sesstext">{session.preview || '(无预览)'}</span>
        </span>
        <span className="sb-session-meta">
          {!waitingForAnswer && <span className="sb-sesstime">{relTime(session.mtime)}</span>}
          {unread && !waitingForAnswer && <span className="sb-unread" role="status" aria-label="有新结果，未查看" title="有新结果，未查看" />}
          {waitingForAnswer && (
            <span className="sb-question-pending" role="status" aria-label="等待你的回答" title="等待你的回答">
              <Icon name="message" /> 待回答
            </span>
          )}
          {showProjectName && projectName && <span className="sb-sess-proj">{projectName}</span>}
        </span>
        {running && !waitingForAnswer && <span className="sb-running" role="status" data-background-waiting={status?.waiting || undefined} aria-label={status?.label ?? '正在运行'} title={status?.label ?? '正在运行'} />}
      </button>
      {hover.tooltip}
      <span className="sb-sess-acts" onMouseEnter={hover.dismiss} onFocus={hover.dismiss}>
        {onMenu && <button type="button" className="sb-act" aria-haspopup="menu"
          title="会话操作" aria-label={`会话操作：${session.preview || '(无预览)'}`}
          onClick={(event) => onMenu(event, cwd, session)}>···</button>}
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
          title={running ? '存档并停止运行，取消排队消息' : '存档会话（取消排队消息）'}
          aria-label={`存档会话：${session.preview || '(无预览)'}`}
          onClick={() => onArchive(cwd, session)}
        >
          <Icon name="archive" />
        </button>
      </span>
    </div>
  )
}

// Saved hosts this Mac connects to. The count is a status read, not a reachability
// proof; a failed read shows no count instead of 0.
function HostsNavItem({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { connections, error } = useDesktopConnections()
  const connected = connections.filter((connection) => connection.state === 'connected').length
  return (
    <button
      type="button"
      className={`sb-navitem sb-hosts ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <Icon name="server" /> 主机
      {connections.length > 0 && !error && (
        <span className="sb-nav-count" aria-label={`已连接 ${connected} / ${connections.length} 台`}>{connected}/{connections.length}</span>
      )}
    </button>
  )
}
