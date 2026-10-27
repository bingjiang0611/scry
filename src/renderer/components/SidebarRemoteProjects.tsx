// Remote rows share local activity styling. The App refreshes host catalogs even
// for background sessions; disconnected or failed reads are not live evidence.
// Session actions execute on the owning host; cached/offline rows cannot mutate it.
import { useMemo, useRef, useState, type MouseEvent } from 'react'
import type { DesktopRemoteAPI, RemoteSessionRef } from '@shared/desktop-remote'
import { REMOTE_SESSION_COPY as copy } from '../constants/copy'
import { SessionRenameMenu, type SessionMenuTarget } from './SessionRename'
import { providerIdForAgentId } from '@shared/runtime'
import { basename, relTime } from '../format'
import { useDesktopConnections } from '../hooks/useDesktopConnections'
import { refreshRemoteCatalog, useRemoteCatalogs } from '../hooks/useRemoteCatalogs'
import { remoteSessionAttentionKey } from '@shared/remote-session-attention'
import { hostState } from './LocationPicker'
import { Icon } from './primitives/Icon'
import { ProviderGlyph } from './ProviderGlyph'
import type { ComposerDraftStore } from '../composer-drafts'
import { remoteDraftKey } from './RemoteChat'
import { SessionDraftIndicator } from './SessionDraftIndicator'

export interface ActiveRemoteLocation {
  connectionId: string
  cwd: string
  externalSessionId?: string
}

export type RemoteProjectGroup = ReturnType<typeof useRemoteProjectGroups>[number]

// Only projects that have sessions are listed; empty host projects stay in the location picker.
export function useRemoteProjectGroups(query: string, archived = false) {
  const { connections, refreshing, error: readError } = useDesktopConnections()
  const catalogs = useRemoteCatalogs()
  const ql = query.trim().toLowerCase()
  return useMemo(() => connections.flatMap((connection) => {
    const entry = catalogs.get(connection.id)
    const catalog = entry?.catalog
    if (!catalog) return []
    const state = hostState(connection, readError ?? entry.error ?? null, refreshing || entry.stale)
    const labels = new Map(catalog.projects.map((project) => [project.path, project.label]))
    const byProject = new Map<string, RemoteSessionRef[]>()
    for (const session of catalog.sessions) {
      if (!session.externalSessionId || Boolean(session.archivedAt) !== archived) continue
      const name = labels.get(session.cwd) ?? basename(session.cwd)
      if (ql && !session.label.toLowerCase().includes(ql) && !name.toLowerCase().includes(ql) && !connection.label.toLowerCase().includes(ql)) continue
      byProject.set(session.cwd, [...(byProject.get(session.cwd) ?? []), session])
    }
    return [...byProject].map(([cwd, sessions]) => ({
      key: JSON.stringify([connection.id, cwd]),
      connection,
      state,
      cwd,
      name: labels.get(cwd) ?? basename(cwd),
      mtime: Math.max(...sessions.map((session) => session.ts)),
      canManage: catalog.sessionActions === true && state === 'connected',
      canDelete: catalog.sessionDelete === true && state === 'connected',
      needsUpgrade: catalog.sessionActions !== true && state === 'connected',
      sessions: sessions.sort((left, right) => (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0) || right.ts - left.ts)
    }))
  }), [connections, catalogs, ql, readError, refreshing, archived])
}

export function SidebarRemoteProjects({
  groups,
  layout = 'projects',
  active,
  draftStore,
  collapsed,
  onToggle,
  onPickSession,
  onNewProjectChat,
  onArchiveSession,
  onArchivedSession
}: {
  groups: RemoteProjectGroup[]
  layout?: 'projects' | 'activity'
  active: ActiveRemoteLocation | null
  draftStore?: ComposerDraftStore
  collapsed: ReadonlySet<string>
  onToggle: (key: string) => void
  onPickSession: (connectionId: string, session: RemoteSessionRef) => void
  onNewProjectChat: (connectionId: string, cwd: string) => void
  onArchiveSession?: (connectionId: string, session: RemoteSessionRef) => void
  onArchivedSession?: (connectionId: string, session: RemoteSessionRef) => void
}) {
  const catalogs = useRemoteCatalogs()
  const [menu, setMenu] = useState<{ group: RemoteProjectGroup; session: RemoteSessionRef; target: SessionMenuTarget } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const writing = useRef(false)
  const closeMenu = (): void => {
    const trigger = menu?.target.trigger
    setMenu(null)
    window.requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus() })
  }
  const openMenu = (event: MouseEvent<HTMLButtonElement>, group: RemoteProjectGroup, session: RemoteSessionRef): void => {
    event.preventDefault()
    if (!group.canManage) return
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ group, session, target: {
      cwd: group.cwd, trigger: event.currentTarget,
      left: Math.max(8, Math.min(event.type === 'contextmenu' ? event.clientX : rect.left, window.innerWidth - 208)),
      top: Math.max(8, Math.min(event.type === 'contextmenu' ? event.clientY : rect.bottom, window.innerHeight - 64)),
      session: { ...session, providerId: providerIdForAgentId(session.providerId) ?? 'legacy_unknown',
        preview: session.label, mtime: session.ts, count: 0 }
    } })
  }
  const change = async (group: RemoteProjectGroup, session: RemoteSessionRef,
    action: Parameters<DesktopRemoteAPI['sessionAction']>[2]): Promise<void> => {
    if (writing.current || !group.canManage) throw new Error('主机未连接、正在保存，或需要更新远端 Scry。')
    writing.current = true; setPending(true); setError(null)
    if (action.kind === 'archive' && action.archived) onArchiveSession?.(group.connection.id, session)
    try {
      const changed = await window.scry.desktopRemote.sessionAction(group.connection.id, {
        cwd: group.cwd, providerId: session.providerId, agentProfileId: session.agentProfileId,
        externalSessionId: session.externalSessionId
      }, action)
      if (!changed) throw new Error('远端未确认会话更新，请刷新后核对。')
      if (action.kind === 'archive' && action.archived) onArchivedSession?.(group.connection.id, session)
    } finally {
      writing.current = false; setPending(false)
      // An error may follow a committed write. Read back; never repeat the write.
      void refreshRemoteCatalog(group.connection.id)
    }
  }
  const dispatch = (group: RemoteProjectGroup, session: RemoteSessionRef,
    action: Parameters<DesktopRemoteAPI['sessionAction']>[2]): void => {
    void change(group, session, action).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  return (
    <>
      {error && <div className="sb-catalog-warning" role="alert">{error}</div>}
      {groups.map((group) => {
        const open = layout === 'activity' || !collapsed.has(group.key)
        const projectSelected = active?.connectionId === group.connection.id && active.cwd === group.cwd && !active.externalSessionId
        return (
          <div key={group.key} className={`sb-proj sb-remote-proj ${open ? 'open' : ''}`} data-connection-id={group.connection.id}>
            {layout === 'projects' && <div className={`sb-proj-row ${projectSelected ? 'active' : ''}`}>
              <button
                type="button"
                className={`sb-proj-head ${projectSelected ? 'on' : ''}`}
                aria-label={`${group.name} · ${group.connection.label} · ${group.cwd}`}
                aria-expanded={open}
                onClick={() => onToggle(group.key)}
              >
                <Icon name="folder" className="sb-project-folder" />
                <span className="pname">{group.name}</span>
                <span className="sb-host-tag" data-state={group.state} title={`在 ${group.connection.label} 上执行`}>{group.connection.label}</span>
              </button>
              <span className="sb-proj-acts">
                <button
                  type="button"
                  className="sb-proj-act sb-proj-new"
                  title={`在 ${group.connection.label} / ${group.name} 中新建会话`}
                  aria-label={`在 ${group.connection.label} / ${group.name} 中新建会话`}
                  onClick={() => onNewProjectChat(group.connection.id, group.cwd)}
                >
                  <Icon name="plus" />
                </button>
              </span>
            </div>}
            {open && (
              <div className="sb-sess-list">
                {group.needsUpgrade && <p className="sb-empty" role="status">{copy.upgrade(group.connection.label)}</p>}
                {group.sessions.map((session) => {
                  const selected = active?.connectionId === group.connection.id && active.cwd === group.cwd && active.externalSessionId === session.externalSessionId
                  const provider = providerIdForAgentId(session.providerId)
                  const running = group.state === 'connected' && session.isActive === true
                  const unread = catalogs.get(group.connection.id)?.unreadSessionKeys?.has(remoteSessionAttentionKey(group.connection.id, session))
                  return (
                    <div className="sb-sess-row" key={session.sessionId}>
                      <button
                        type="button"
                        className={['sb-sess', selected && 'active', running && 'running', unread && 'unread'].filter(Boolean).join(' ')}
                        data-provider={session.providerId}
                        data-remote-session={session.externalSessionId}
                        aria-current={selected ? 'true' : undefined}
                        title={`${session.label}\n${group.connection.label} · ${group.cwd}`}
                        onContextMenu={(event) => openMenu(event, group, session)}
                        onClick={() => onPickSession(group.connection.id, session)}
                      >
                        <span className="sb-session-main">
                          {provider ? <ProviderGlyph className="sb-provider" provider={provider} /> : <Icon name="cube" className="sb-provider" />}
                          {draftStore && <SessionDraftIndicator store={draftStore} draftKey={remoteDraftKey(group.connection.id, group.cwd, session.externalSessionId)} />}
                          <span className="sb-sesstext">{session.label || '(无预览)'}</span>
                          {layout === 'activity' && <span className="sb-host-tag" data-state={group.state}>{group.connection.label}</span>}
                        </span>
                        <span className="sb-session-meta">
                          {Boolean(session.pinnedAt) && <Icon name="pin" />}
                          <span className="sb-sesstime">{relTime(session.ts)}</span>
                        </span>
                        {running && <span className="sb-running" role="status" aria-label="正在运行" title="正在运行" />}
                        {unread && <span className="sb-unread" role="status" aria-label={copy.unreadResult} title={copy.unreadResult} />}
                      </button>
                      <span className="sb-sess-acts" title={!group.canManage ? copy.upgrade(group.connection.label) : undefined}>
                        <button type="button" className="sb-act" aria-haspopup="menu" disabled={!group.canManage || pending}
                          aria-label={`会话操作：${session.label}`} onClick={event => openMenu(event, group, session)}>···</button>
                        <button type="button" className={`sb-act ${session.pinnedAt ? 'on' : ''}`} disabled={!group.canManage || pending}
                          aria-label={`${session.pinnedAt ? '取消置顶' : '置顶'}：${session.label}`} aria-pressed={Boolean(session.pinnedAt)}
                          onClick={() => dispatch(group, session, { kind: 'pin', pinned: !session.pinnedAt })}><Icon name="pin" /></button>
                        <button type="button" className="sb-act" disabled={!group.canManage || pending}
                          aria-label={copy.archiveLabel(session.label)}
                          title={copy.archiveHint}
                          onClick={() => dispatch(group, session, { kind: 'archive', archived: true })}><Icon name="archive" /></button>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      {menu && <SessionRenameMenu target={menu.target} onClose={closeMenu}
        onRename={(_cwd, _session, title) => change(menu.group, menu.session, { kind: 'rename', title })} />}
    </>
  )
}
