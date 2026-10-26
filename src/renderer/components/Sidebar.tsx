// 左侧栏（蓝本 welcome/chat 通用）：brand+版本 / 新建会话 / 搜索 / 置顶分组 / 按工作目录分组的历史会话。
// 会话行的置顶与存档是行内 hover 按钮；删除只在设置的「已存档会话」里发生，这里没有删除入口。
import { memo, useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { relTime } from '../format'
import { sidebarActivity } from '../sidebar-activity'
import { SIDEBAR_ACTIVITY_COPY as activityCopy } from '../constants/copy'
import { SidebarActivity } from './SidebarActivity'
import { SessionRow } from './SidebarSessionRow'
import { SidebarProjects } from './SidebarProjects'
import { ProjectDialog } from './SidebarProjectDialog'
import type { BackgroundWork } from '@shared/background-work'
import type { ConversationSummary } from '@shared/conversation-api'
import { sessionAttentionKey } from '@shared/session-attention'
import { Icon } from './primitives/Icon'
import type { ProjectMeta, SessionMeta } from '../env'
import type { SessionProviderId } from '@shared/provider'
import type { CatalogHealth } from '@shared/provider'
import { sessionMatchesSelection } from '../session-selection'
import { SessionRenameMenu, type SessionMenuTarget } from './SessionRename'
import { SessionHoverProvider } from './SessionHoverCard'
import { composerDraftKey, type ComposerDraftStore } from '../composer-drafts'
import { SessionDraftIndicator } from './SessionDraftIndicator'
import type { RemoteSessionRef } from '@shared/desktop-remote'
import { SidebarRemoteProjects, useRemoteProjectGroups, type ActiveRemoteLocation } from './SidebarRemoteProjects'
import { SidebarProjectMenu } from './SidebarProjectMenu'
import { useTabIndicator } from '../hooks/useTabIndicator'
import { browserStorage } from '../browser-storage'
import { persistSidebarView, readStoredSidebarView, type SidebarView } from '../sidebar-view'

const sessionKey = (cwd: string, session: SessionMeta): string =>
  `${cwd}:${session.providerId}:${session.agentProfileId ?? ''}:${session.sessionId}`

export const Sidebar = memo(function Sidebar({
  id,
  projects,
  activeCwd,
  activeSessionId = null,
  activeConversationId,
  onPickConversation,
  activeProviderId,
  activeAgentProfileId,
  draftStore,
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
  activeRemote = null,
  onPickRemoteSession,
  onNewRemoteProjectChat,
  onArchiveRemoteSession,
  onArchivedRemoteSession
}: {
  id?: string
  projects: ProjectMeta[]
  activeCwd: string | null
  activeSessionId?: string | null
  activeConversationId?: string
  onPickConversation?: (conversation: ConversationSummary) => void
  activeProviderId?: SessionProviderId
  activeAgentProfileId?: string
  draftStore?: ComposerDraftStore
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
  activeRemote?: ActiveRemoteLocation | null
  onPickRemoteSession?: (connectionId: string, session: RemoteSessionRef) => void
  onNewRemoteProjectChat?: (connectionId: string, cwd: string) => void
  onArchiveRemoteSession?: (connectionId: string, session: RemoteSessionRef) => void
  onArchivedRemoteSession?: (connectionId: string, session: RemoteSessionRef) => void
}) {
  const [sessionMenu, setSessionMenu] = useState<SessionMenuTarget | null>(null)
  const openSessionMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>, cwd: string, session: SessionMeta): void => {
    event.preventDefault()
    setProjectMenu(null)
    const rect = event.currentTarget.getBoundingClientRect()
    const context = event.type === 'contextmenu' && (event.clientX !== 0 || event.clientY !== 0)
    setSessionMenu({
      cwd, session, trigger: event.currentTarget,
      left: Math.max(8, Math.min(context ? event.clientX : rect.left, window.innerWidth - 208)),
      top: Math.max(8, Math.min(context ? event.clientY : rect.bottom, window.innerHeight - 64))
    })
  }, [])
  const [q, setQ] = useState('')
  // 侧栏 tab 必须跨 renderer 重载保留：崩溃后主进程自动 reload 会重挂全部组件。
  const [view, setViewState] = useState<SidebarView>(() => readStoredSidebarView(browserStorage()))
  const setView = (next: SidebarView): void => {
    persistSidebarView(next, browserStorage())
    setViewState(next)
  }
  const remoteGroups = useRemoteProjectGroups(q)
  const showRemote = Boolean(onPickRemoteSession && onNewRemoteProjectChat) && remoteGroups.length > 0
  const activity = useMemo(() => view === 'activity'
    ? sidebarActivity(projects, runningRunIds, waitingQuestionRunIds, q, showRemote ? remoteGroups : [], unreadSessionKeys) : [],
  [view, projects, runningRunIds, waitingQuestionRunIds, q, showRemote, remoteGroups, unreadSessionKeys])
  const tabId = `${id ?? 'sidebar'}-view`
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [projectMenu, setProjectMenu] = useState<{ project: ProjectMeta; left: number; top: number } | null>(null)
  const [projectDialog, setProjectDialog] = useState<{ mode: 'rename' | 'remove'; project: ProjectMeta } | null>(null)
  const viewTabRefs = useRef(new Map<string, HTMLElement | null>())
  const viewTabsRef = useRef<HTMLDivElement>(null)
  const { indicatorRef: viewIndicatorRef } = useTabIndicator(viewTabsRef, view, viewTabRefs.current, ['projects', 'activity'])
  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
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
  const renderSession = (cwd: string, session: SessionMeta, projectName: string, showProjectName = false, motionKey?: string) => <SessionRow
    key={sessionKey(cwd, session)} cwd={cwd} session={session} projectName={projectName} showProjectName={showProjectName} motionKey={motionKey}
    relativeTime={relTime(session.mtime)} draftStore={draftStore} active={isActive(cwd, session)}
    running={Boolean(session.runId && runningRunIds.has(session.runId))}
    waitingForAnswer={Boolean(session.runId && waitingQuestionRunIds.has(session.runId))}
    unread={unreadSessionKeys.has(sessionAttentionKey({ providerId: session.providerId,
      agentProfileId: session.agentProfileId, cwd, sessionId: session.externalSessionId ?? session.sessionId }))}
    backgroundWork={session.runId ? backgroundWorkByRun[session.runId] : undefined}
    onPick={onPick} onTogglePin={onTogglePin} onArchive={onArchive}
    onMenu={onRenameSession ? openSessionMenu : undefined} />
  const renderConversation = (conversation: ConversationSummary) => <div className="sb-sess-row" data-motion-key={view === 'projects' ? `conversation:${conversation.id}` : undefined} key={conversation.id}>
    <button className={`sb-sess${activeConversationId === conversation.id ? ' active' : ''}`} aria-current={activeConversationId === conversation.id ? 'true' : undefined} onClick={() => onPickConversation?.(conversation)} data-conversation-id={conversation.id}>
      <span className="sb-session-main">
        <Icon name={conversation.pinnedAt ? 'pin' : 'message'} />
        {draftStore && <SessionDraftIndicator store={draftStore} draftKey={composerDraftKey({ providerId: 'conversation', cwd: conversation.cwd, sessionId: conversation.id })} />}
        <span className="sb-sesstext" title={conversation.cwd}>{conversation.title}</span>
      </span>
      <span className="sb-session-meta">{conversation.activeRunId ? waitingQuestionRunIds.has(conversation.activeRunId) ? '需回答' : '运行中' : conversation.deletion ? conversation.deletion.status === 'complete' ? '副本待核对' : '删除未完成' : conversation.blockedReason ? '需核对' : `${conversation.turnCount} 轮`}</span>
    </button>
  </div>
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

      {(onAnalytics || onLlmPerformance || onSkills || onMcp || onMetaPrompts) && (
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
        </nav>
      )}

      <div className="sb-view-tabs" ref={viewTabsRef} role="tablist" aria-label={activityCopy.navigation} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 'projects' : event.key === 'End' ? 'activity' : view === 'projects' ? 'activity' : 'projects'
        setView(next)
        document.getElementById(`${tabId}-${next}`)?.focus()
      }}>
        {(['projects', 'activity'] as const).map((tab) => <button key={tab} ref={(node) => { viewTabRefs.current.set(tab, node) }} type="button" role="tab"
          id={`${tabId}-${tab}`} aria-selected={view === tab} aria-controls={`${tabId}-panel`}
          tabIndex={view === tab ? 0 : -1} title={tab === 'activity' ? activityCopy.scope : undefined} onClick={() => setView(tab)}>
          {activityCopy[tab]}
        </button>)}
        <span ref={viewIndicatorRef} className="motion-tab-indicator" aria-hidden="true" />
      </div>
      <SessionHoverProvider><div className="sb-list" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${view}`} tabIndex={0}>
        {catalogHealth && catalogHealth.status !== 'ready' && (
          <div className="sb-empty" role="status" title={catalogHealth.reason}>
            {catalogHealth.status === 'degraded'
              ? '会话索引已从备份恢复；下一次成功写入会修复主索引。'
              : '会话索引不可用；请检查 app-sessions.json 与 .bak 后重试。'}
          </div>
        )}
        {view === 'activity' ? <>
          <SidebarActivity entries={activity} renderEntry={(entry) => entry.kind === 'conversation'
            ? renderConversation(entry.conversation)
            : entry.kind === 'remote' ? <SidebarRemoteProjects groups={[{ ...entry.project, sessions: [entry.session] }]}
              draftStore={draftStore} layout="activity" active={activeRemote} collapsed={collapsed} onToggle={toggle}
              onPickSession={onPickRemoteSession!} onNewProjectChat={onNewRemoteProjectChat!}
              onArchiveSession={onArchiveRemoteSession} onArchivedSession={onArchivedRemoteSession} />
            : renderSession(entry.project.cwd, entry.session, entry.project.name)}
          />
        </> : <>
          <SidebarProjects projects={projects} q={q} remoteGroups={remoteGroups} showRemote={showRemote}
            activeCwd={activeCwd} activeSessionId={activeSessionId} collapsed={collapsed} toggle={toggle}
            onNewProjectChat={onNewProjectChat} openProjectMenu={openProjectMenu}
            renderSession={renderSession} renderConversation={renderConversation}
            renderRemoteProject={(project) => <SidebarRemoteProjects key={project.key} groups={[project]}
              draftStore={draftStore} active={activeRemote} collapsed={collapsed} onToggle={toggle}
              onPickSession={onPickRemoteSession!} onNewProjectChat={onNewRemoteProjectChat!}
              onArchiveSession={onArchiveRemoteSession} onArchivedSession={onArchivedRemoteSession} />} />
        </>}
      </div></SessionHoverProvider>

      {sessionMenu && onRenameSession && (
        <SessionRenameMenu target={sessionMenu} onRename={onRenameSession} onAdopted={onPickConversation ? conversation => {
          onPickConversation(conversation)
          setSessionMenu(null)
          window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-conversation-id="${conversation.id}"] textarea`)?.focus())
        } : undefined} onClose={() => {
          const trigger = sessionMenu.trigger
          setSessionMenu(null)
          window.requestAnimationFrame(() => { if (trigger.isConnected) trigger.focus() })
        }} />
      )}

      {projectMenu && (
        <SidebarProjectMenu
          menu={projectMenu}
          onClose={() => setProjectMenu(null)}
          onNewProjectChat={onNewProjectChat}
          onToggleProjectPin={onToggleProjectPin}
          onRevealProject={onRevealProject}
          onRenameProject={(project) => { setProjectDialog({ mode: 'rename', project }); setProjectMenu(null) }}
          onRemoveProject={(project) => { setProjectDialog({ mode: 'remove', project }); setProjectMenu(null) }}
        />
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
