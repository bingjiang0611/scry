// 侧栏中的远程项目：与本机项目同一种行样式，只多一个主机标签。数据来自各主机的
// catalog 快照（连接时读取，运行结束后刷新），不是实时运行状态，所以这里不显示
// running/未读指示，也不提供本机才有的置顶、存档和重命名菜单。
import { useState } from 'react'
import type { RemoteSessionRef } from '@shared/desktop-remote'
import { providerIdForAgentId } from '@shared/runtime'
import { basename, relTime } from '../format'
import { useDesktopConnections } from '../hooks/useDesktopConnections'
import { useRemoteCatalogs } from '../hooks/useRemoteCatalogs'
import { hostState } from './LocationPicker'
import { Icon } from './primitives/Icon'
import { ProviderGlyph } from './ProviderGlyph'

export interface ActiveRemoteLocation {
  connectionId: string
  cwd: string
  externalSessionId?: string
}

export type RemoteProjectGroup = ReturnType<typeof useRemoteProjectGroups>[number]

// Only projects that have sessions are listed; empty host projects stay in the location picker.
export function useRemoteProjectGroups(query: string) {
  const { connections, error: readError } = useDesktopConnections()
  const catalogs = useRemoteCatalogs()
  const ql = query.trim().toLowerCase()
  return connections.flatMap((connection) => {
    const catalog = catalogs.get(connection.id)?.catalog
    if (!catalog) return []
    const state = hostState(connection, readError)
    const labels = new Map(catalog.projects.map((project) => [project.path, project.label]))
    const byProject = new Map<string, RemoteSessionRef[]>()
    for (const session of catalog.sessions) {
      if (!session.externalSessionId) continue
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
      sessions: sessions.sort((left, right) => right.ts - left.ts)
    }))
  })
}

export function SidebarRemoteProjects({
  groups,
  active,
  onPickSession,
  onNewProjectChat
}: {
  groups: RemoteProjectGroup[]
  active: ActiveRemoteLocation | null
  onPickSession: (connectionId: string, session: RemoteSessionRef) => void
  onNewProjectChat: (connectionId: string, cwd: string) => void
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  return (
    <>
      {groups.map((group) => {
        const open = !collapsed.has(group.key)
        const projectSelected = active?.connectionId === group.connection.id && active.cwd === group.cwd && !active.externalSessionId
        return (
          <div key={group.key} className={`sb-proj sb-remote-proj ${open ? 'open' : ''}`} data-connection-id={group.connection.id}>
            <div className={`sb-proj-row ${projectSelected ? 'active' : ''}`}>
              <button
                type="button"
                className={`sb-proj-head ${projectSelected ? 'on' : ''}`}
                aria-label={`${group.name} · ${group.connection.label} · ${group.cwd}`}
                aria-expanded={open}
                onClick={() => setCollapsed((current) => {
                  const next = new Set(current)
                  if (!next.delete(group.key)) next.add(group.key)
                  return next
                })}
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
            </div>
            {open && (
              <div className="sb-sess-list">
                {group.sessions.map((session) => {
                  const selected = active?.connectionId === group.connection.id && active.cwd === group.cwd && active.externalSessionId === session.externalSessionId
                  const provider = providerIdForAgentId(session.providerId)
                  return (
                    <div className="sb-sess-row" key={session.sessionId}>
                      <button
                        type="button"
                        className={`sb-sess ${selected ? 'active' : ''}`}
                        data-provider={session.providerId}
                        data-remote-session={session.externalSessionId}
                        aria-current={selected ? 'true' : undefined}
                        title={`${session.label}\n${group.connection.label} · ${group.cwd}`}
                        onClick={() => onPickSession(group.connection.id, session)}
                      >
                        <span className="sb-session-main">
                          {provider ? <ProviderGlyph className="sb-provider" provider={provider} /> : <Icon name="cube" className="sb-provider" />}
                          <span className="sb-sesstext">{session.label || '(无预览)'}</span>
                        </span>
                        <span className="sb-session-meta">
                          <span className="sb-sesstime">{relTime(session.ts)}</span>
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
