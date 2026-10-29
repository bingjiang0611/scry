import { useState } from 'react'

import type { ProjectMeta, SessionMeta } from '../env'

import type { DeleteArchivedSessionsResult } from '@shared/provider'
import { Icon } from './primitives/Icon'






import './archived-sessions.css'

import { ARCHIVED_SESSIONS_COPY as archivedCopy } from '../constants/copy'



const archivedAtFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})
const archivedAtLabel = (ms?: number): string =>
  ms == null
    ? '存档时间未知'
    : `存档于 ${archivedAtFormatter.format(new Date(ms))}`

const DELETE_FAILURE_LABEL: Record<NonNullable<DeleteArchivedSessionsResult['failures'][number]['reason']>, string> = {
  invalid_request: '缺少 Provider 会话 id，无法删除',
  active_session: '会话正在运行',
  user_cancelled: '已取消',
  partial_failure: '部分存储删除失败，catalog 已保留供重试'
}

export function ArchivedChatsPanel({
  projects,
  onRefresh,
  onSessionsChanged
}: {
  projects: ProjectMeta[] | null
  onRefresh: () => Promise<void>
  onSessionsChanged: () => void
}) {
  const [query, setQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState<string>('all')
  const [projectFilter, setProjectFilter] = useState<string>('all')
  const [failures, setFailures] = useState<DeleteArchivedSessionsResult['failures']>([])
  const [busy, setBusy] = useState(false)

  if (!projects) {
    return (
      <div className="arch-empty" role="status">
        <b>会话索引不可用</b>
        <span>读不到 app-sessions.json，无法列出已存档会话；修复索引后重开设置。</span>
      </div>
    )
  }

  const total = projects.reduce((sum, project) => sum + project.sessions.length, 0)
  const ql = query.trim().toLowerCase()
  const groups = projects
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) =>
        (!ql || session.preview.toLowerCase().includes(ql)) &&
        (providerFilter === 'all' || session.providerId === providerFilter) &&
        (projectFilter === 'all' || (project.cwd || 'none') === projectFilter))
    }))
    .filter((project) => project.sessions.length > 0)
  const matched = groups.reduce((sum, project) => sum + project.sessions.length, 0)
  const providers = [...new Set(projects.flatMap((project) => project.sessions.map((session) => session.providerId)))]

  const afterChange = async (): Promise<void> => {
    await onRefresh()
    onSessionsChanged()
  }

  const unarchive = async (cwd: string, session: SessionMeta): Promise<void> => {
    setBusy(true)
    try {
      await window.scry.setSessionArchived(
        {
          providerId: session.providerId,
          agentProfileId: session.agentProfileId,
          cwd,
          externalSessionId: session.externalSessionId ?? session.sessionId
        },
        false
      )
      await afterChange()
    } finally {
      setBusy(false)
    }
  }

  const deleteOne = async (cwd: string, session: SessionMeta): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.scry.deleteSession({
        providerId: session.providerId,
        agentProfileId: session.agentProfileId,
        cwd,
        externalSessionId: session.externalSessionId ?? session.sessionId
      })
      if (result.ok) setFailures([])
      else if (!result.cancelled) {
        setFailures([{ preview: session.preview, reason: result.reason ?? 'partial_failure' }])
      }
      await afterChange()
    } finally {
      setBusy(false)
    }
  }

  const deleteAll = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.scry.deleteArchivedSessions()
      setFailures(result.failures)
      await afterChange()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="arch-head">
        <div className="settings-copy">
          <b>{archivedCopy.localTitle}</b>
        </div>
        <button
          type="button"
          className="arch-danger"
          disabled={total === 0 || busy}
          onClick={() => void deleteAll()}
        >
          <Icon name="trash" /> {archivedCopy.deleteAllLocal}
        </button>
      </div>

      {failures.length > 0 && (
        <div className="arch-failures" role="alert">
          {failures.length} 个会话未删除，catalog 已保留供重试：
          {failures.map((failure) => (
            <div key={`${failure.preview}:${failure.reason}`}>
              {failure.preview || '(无预览)'} — {DELETE_FAILURE_LABEL[failure.reason]}
            </div>
          ))}
        </div>
      )}

      <div className="arch-tools">
        <label className="arch-search">
          <Icon name="search" />
          <input
            placeholder="搜索已存档会话…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索已存档会话"
          />
        </label>
        <label className="arch-filter">
          <Icon name="filter" />
          <select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)} aria-label="按 Provider 筛选">
            <option value="all">全部 Provider</option>
            {providers.map((provider) => (
              <option key={provider} value={provider}>{provider === 'legacy_unknown' ? '历史?' : provider}</option>
            ))}
          </select>
        </label>
        <label className="arch-filter">
          <Icon name="folder" />
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label="按项目筛选">
            <option value="all">全部项目</option>
            {projects.map((project) => (
              <option key={project.cwd || 'none'} value={project.cwd || 'none'}>{project.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="arch-list">
        {total === 0 && (
          <div className="arch-empty">
            <b>{archivedCopy.localEmpty}</b>
            <span>在左侧列表把鼠标移到会话上，点存档图标就会收进这里。</span>
          </div>
        )}
        {total > 0 && matched === 0 && (
          <div className="arch-empty">
            <b>没有匹配的会话</b>
            <span>当前筛选条件下没有结果；换个关键词或把筛选改回「全部」。</span>
          </div>
        )}
        {groups.map((project) => (
          <section className="arch-group" key={project.cwd || 'none'}>
            <header className="arch-group-head">
              <Icon name="folder" />
              <b>{project.name}</b>
              <span className="cnt">{project.sessions.length} 个会话</span>
            </header>
            <div className="arch-group-body">
              {project.sessions.map((session) => (
                <div className="arch-row" key={`${session.providerId}:${session.agentProfileId ?? ''}:${session.sessionId}`}>
                  <div className="arch-row-copy">
                    <b title={session.preview}>{session.preview || '(无预览)'}</b>
                    <div className="arch-row-meta">
                      <span>{session.providerId === 'legacy_unknown' ? '历史?' : session.providerId}</span>
                      <span>{session.count} 轮</span>
                      <span>{archivedAtLabel(session.archivedAt)}</span>
                    </div>
                  </div>
                  <div className="arch-row-acts">
                    <button
                      type="button"
                      className="arch-del"
                      title="永久删除"
                      aria-label={`永久删除：${session.preview || '(无预览)'}`}
                      disabled={busy}
                      onClick={() => void deleteOne(session.cwd ?? project.cwd, session)}
                    >
                      <Icon name="trash" />
                    </button>
                    <button
                      type="button"
                      className="arch-unarch"
                      disabled={busy}
                      onClick={() => void unarchive(session.cwd ?? project.cwd, session)}
                    >
                      取消存档
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}
