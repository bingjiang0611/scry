import { useMemo, useRef, type MouseEvent, type ReactNode } from 'react'
import type { ConversationSummary } from '@shared/conversation-api'
import type { ProjectMeta, SessionMeta } from '../env'
import { SIDEBAR_PROJECT_COPY as copy } from '../constants/copy'
import { Icon } from './primitives/Icon'
import type { RemoteProjectGroup } from './SidebarRemoteProjects'
import { Disclosure } from './Disclosure'
import { useFlipList } from '../hooks/useFlipList'

function SessionMotionList({ revision, children, className = 'sb-sess-list' }: { revision: unknown; children: ReactNode; className?: string }) {
  const root = useRef<HTMLDivElement>(null)
  useFlipList(root, revision)
  return <div className={className} ref={root}>{children}</div>
}

export function SidebarProjects({
  projects, q, remoteGroups, showRemote, activeCwd, activeSessionId, collapsed, toggle,
  onNewProjectChat, openProjectMenu, renderSession, renderConversation, renderRemoteProject
}: {
  projects: ProjectMeta[]
  q: string
  remoteGroups: RemoteProjectGroup[]
  showRemote: boolean
  activeCwd: string | null
  activeSessionId: string | null
  collapsed: ReadonlySet<string>
  toggle: (key: string) => void
  onNewProjectChat?: (cwd: string) => void
  openProjectMenu: (event: MouseEvent<HTMLButtonElement>, project: ProjectMeta) => void
  renderSession: (cwd: string, session: SessionMeta, projectName: string, showProjectName?: boolean, motionKey?: string) => ReactNode
  renderConversation: (conversation: ConversationSummary) => ReactNode
  renderRemoteProject: (project: RemoteProjectGroup) => ReactNode
}) {
  const ql = q.trim().toLowerCase()
  const { pinned, filtered } = useMemo(() => {
    const matches = (session: SessionMeta): boolean => !ql || session.preview.toLowerCase().includes(ql)
    // 置顶会话跨项目平铺，从原项目分组里移出；行内带项目名。
    const pinned = projects
      .flatMap((project) => project.sessions
        .filter((session) => session.pinnedAt && matches(session))
        .map((session) => ({ session, cwd: session.cwd ?? project.cwd, name: project.name })))
      .sort((a, b) => (b.session.pinnedAt ?? 0) - (a.session.pinnedAt ?? 0))
    const pinnedRows = [
      ...pinned.map(row => ({ kind: 'native' as const, ...row, pinnedAt: row.session.pinnedAt ?? 0 })),
      // A side-chat child is shown under its parent row and in its own group, never as a
      // root conversation: the root list stays the list of sources.
      ...projects.flatMap(project => (project.conversations ?? []).filter(conversation => conversation.pinnedAt && !conversation.archivedAt &&
        !conversation.sideChat &&
        (!ql || conversation.title.toLowerCase().includes(ql) || project.cwd.toLowerCase().includes(ql)))
        .map(conversation => ({ kind: 'conversation' as const, conversation, pinnedAt: conversation.pinnedAt ?? 0 })))
    ].sort((a, b) => b.pinnedAt - a.pinnedAt)
    const filtered = projects
      .map((project) => ({
        ...project,
        totalSessions: project.sessions.length + (project.conversations?.filter(conversation => !conversation.archivedAt &&
          !conversation.sideChat).length ?? 0),
        conversations: (project.conversations ?? []).filter((conversation) => !conversation.pinnedAt && !conversation.archivedAt &&
          !conversation.sideChat && (!ql || conversation.title.toLowerCase().includes(ql) || project.cwd.toLowerCase().includes(ql))),
        projectMatch: !ql || project.name.toLowerCase().includes(ql) || project.cwd.toLowerCase().includes(ql),
        sessions: project.sessions.filter((session) => !session.pinnedAt && matches(session))
      }))
      .filter((project) => project.projectMatch || project.sessions.length > 0 || project.conversations.length > 0)
    return { pinned: pinnedRows, filtered }
  }, [projects, ql])
  // Match local project ordering: named roots, explicit pins, then recent activity.
  // Remote projects must not live in a separate tail section below every local root.
  const projectGroups = [
    ...filtered.map((project) => ({ kind: 'local' as const, project, cwd: project.cwd, pinnedAt: project.pinnedAt, mtime: project.mtime })),
    ...(showRemote ? remoteGroups.map((project) => ({ kind: 'remote' as const, project, cwd: project.cwd, pinnedAt: undefined, mtime: project.mtime })) : [])
  ].sort((a, b) =>
    Number(!a.cwd) - Number(!b.cwd) ||
    Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)) ||
    (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) ||
    b.mtime - a.mtime
  )
  return <>
    {pinned.length > 0 && (
      <>
        <div className="sb-section">{copy.pinned}</div>
        <SessionMotionList className="sb-pinned" revision={pinned}>
          {pinned.map(row => {
            if (row.kind === 'conversation') return renderConversation(row.conversation)
            const { session, cwd, name } = row
            return renderSession(cwd, session, name, true, `${cwd}:${session.sessionId}`)
          })}
        </SessionMotionList>
        <div className="sb-divider" />
      </>
    )}
    <div className="sb-section sb-project-section">{copy.projects}</div>
    {filtered.length === 0 && pinned.length === 0 && !showRemote && (
      <div className="sb-empty">{projects.length === 0 ? copy.noProjects : copy.noMatches}</div>
    )}
    {projectGroups.map((group) => {
      if (group.kind === 'remote') return renderRemoteProject(group.project)
      const p = group.project
      const open = !collapsed.has(p.cwd)
      const active = p.cwd ? p.cwd === activeCwd : activeCwd == null
      const projectSelected = active && activeSessionId == null
      const emptyLabel = p.totalSessions === 0 ? copy.noSessions : ql ? copy.noSessionMatches : copy.sessionsPinned
      return (
        <div key={p.cwd} className={`sb-proj ${open ? 'open' : ''}`}>
          <div className={`sb-proj-row ${projectSelected ? 'active' : ''}`}>
            <button
              type="button"
              className={`sb-proj-head ${projectSelected ? 'on' : ''}`}
              aria-label={copy.projectLabel(p.name, p.cwd)}
              aria-expanded={open}
              data-project-path={p.cwd}
              onClick={() => toggle(p.cwd)}
            >
              <Icon name="chevronRight" className={`sb-project-chevron motion-chevron ${open ? 'is-open' : ''}`} />
              <Icon name="folder" className="sb-project-folder" />
              <span className="pname">{p.name}</span>
              {p.pinnedAt && <Icon name="pin" className="sb-project-pin" />}
            </button>
            {p.cwd && onNewProjectChat && (
              <span className="sb-proj-acts">
                <button
                  type="button"
                  className="sb-proj-act sb-proj-new"
                  title={copy.newChat(p.name)}
                  aria-label={copy.newChatLabel(p.name, p.cwd)}
                  onClick={() => onNewProjectChat(p.cwd)}
                >
                  <Icon name="plus" />
                </button>
                <button
                  type="button"
                  className="sb-proj-act sb-proj-more"
                  title={copy.manage(p.name)}
                  aria-label={copy.manageLabel(p.name, p.cwd)}
                  onClick={(event) => openProjectMenu(event, p)}
                >
                  {copy.moreGlyph}
                </button>
              </span>
            )}
          </div>
          <Disclosure open={open}>{() => (
            <SessionMotionList revision={`${p.cwd}:${p.conversations.map(conversation => conversation.id).join(',')}:${p.sessions.map(session => session.sessionId).join(',')}`}>
              {p.conversations.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)).map(renderConversation)}
              {p.sessions.map((session) => renderSession(session.cwd ?? p.cwd, session, p.name, false, `${p.cwd}:${session.sessionId}`))}
              {p.sessions.length === 0 && p.conversations.length === 0 && (
                <div className="sb-project-empty">{emptyLabel}</div>
              )}
            </SessionMotionList>
          )}</Disclosure>
        </div>
      )
    })}
  </>
}
