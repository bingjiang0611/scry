// 全局弹窗：设置 / Skills 证据账本 / MCP Fleet。
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject
} from 'react'
import type { McpStatus } from '../format'
import type { SkillMeta, McpMeta, ProjectMeta, SessionMeta } from '../env'
import type { McpLiveStatus } from '@shared/trace'
import type { CapabilityEnvelope, DeleteArchivedSessionsResult, McpSnapshot } from '@shared/provider'
import { Icon } from './primitives/Icon'
import { RemotePairing } from './RemotePairing'
import type { AppTheme } from '../theme'

export function ModalFrame({
  labelledBy,
  initialFocusRef,
  className,
  onClose,
  children
}: {
  labelledBy: string
  initialFocusRef?: RefObject<HTMLElement>
  className?: string
  onClose: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = (): HTMLElement[] => [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? [])]
    let initialTarget: HTMLElement | null = null
    const focusInitial = (): void => {
      const requested = initialFocusRef?.current
      const target = requested && !requested.matches(':disabled') ? requested : focusable()[0] ?? dialogRef.current
      if (!initialTarget) initialTarget = target ?? null
      target?.focus({ preventScroll: true })
    }
    // effect 执行时 DOM 已提交，先同步聚焦；rAF 只用于覆盖随后完成的布局/控件挂载。
    // If the user selected another control inside the modal before that frame, keep that
    // selection. External focus is still redirected by the focus trap below.
    focusInitial()
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement
      if (dialogRef.current?.contains(active) && active !== initialTarget) return
      focusInitial()
    })
    const onFocusIn = (): void => {
      if (dialogRef.current && !dialogRef.current.contains(document.activeElement)) focusInitial()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const controls = focusable()
      if (controls.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown)
      if (restore?.isConnected) restore.focus()
    }
  }, [initialFocusRef])
  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div ref={dialogRef} className={`modal${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
        {children}
      </div>
    </div>
  )
}

type SettingsTab = 'appearance' | 'archived' | 'remote'

export function SettingsModal({
  theme,
  onThemeChange,
  onClose,
  onSessionsChanged,
  onOpenHosts
}: {
  theme: AppTheme
  onThemeChange: (theme: AppTheme) => void
  onClose: () => void
  onSessionsChanged: () => void
  onOpenHosts?: () => void
}) {
  const titleId = useId()
  const appearanceRef = useRef<HTMLButtonElement>(null)
  const [tab, setTab] = useState<SettingsTab>('appearance')
  // null = 还没读到索引；不能当成 0 个已存档会话。
  const [archived, setArchived] = useState<ProjectMeta[] | null>(null)
  const refreshArchived = useCallback(async (): Promise<void> => {
    try {
      setArchived(await window.scry.listArchivedSessions())
    } catch {
      setArchived(null)
    }
  }, [])
  useEffect(() => {
    void refreshArchived()
  }, [refreshArchived])
  const archivedCount = archived?.reduce((sum, project) => sum + project.sessions.length, 0)
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={appearanceRef} className="settings-modal" onClose={onClose}>
      <div className="modal-head">
        <b id={titleId}>设置</b>
        <button className="modal-x" onClick={onClose} aria-label="关闭设置">
          <Icon name="x" />
        </button>
      </div>
      <div className="settings-shell">
        <nav className="settings-rail" aria-label="设置分区">
          <button
            ref={appearanceRef}
            type="button"
            className={`settings-tab ${tab === 'appearance' ? 'active' : ''}`}
            aria-current={tab === 'appearance' ? 'page' : undefined}
            onClick={() => setTab('appearance')}
          >
            <Icon name="settings" /> 外观
          </button>
          <button
            type="button"
            className={`settings-tab ${tab === 'archived' ? 'active' : ''}`}
            aria-current={tab === 'archived' ? 'page' : undefined}
            onClick={() => setTab('archived')}
          >
            <Icon name="archive" /> 已存档会话
            {archivedCount != null && <span className="cnt">{archivedCount}</span>}
          </button>
          <button
            type="button"
            className={`settings-tab ${tab === 'remote' ? 'active' : ''}`}
            aria-current={tab === 'remote' ? 'page' : undefined}
            onClick={() => setTab('remote')}
          >
            <Icon name="globe" /> 远程访问
          </button>
        </nav>
        <div className="settings-pane">
          {tab === 'appearance' ? (
            <div className="settings-body">
              <div className="settings-copy">
                <b>外观</b>
                <span>选择 Scry 的全局界面主题。</span>
              </div>
              <div className="theme-options" role="radiogroup" aria-label="界面主题">
                <button
                  type="button"
                  className={`theme-option ${theme === 'dark' ? 'active' : ''}`}
                  role="radio"
                  aria-checked={theme === 'dark'}
                  onClick={() => onThemeChange('dark')}
                >
                  <span className="theme-preview dark" aria-hidden="true">
                    <span />
                    <i />
                  </span>
                  <span className="theme-option-copy">
                    <b>深色</b>
                    <small>低光环境</small>
                  </span>
                  <span className="theme-check" aria-hidden="true"><Icon name="check" /></span>
                </button>
                <button
                  type="button"
                  className={`theme-option ${theme === 'light' ? 'active' : ''}`}
                  role="radio"
                  aria-checked={theme === 'light'}
                  onClick={() => onThemeChange('light')}
                >
                  <span className="theme-preview light" aria-hidden="true">
                    <span />
                    <i />
                  </span>
                  <span className="theme-option-copy">
                    <b>浅色</b>
                    <small>明亮环境</small>
                  </span>
                  <span className="theme-check" aria-hidden="true"><Icon name="check" /></span>
                </button>
              </div>
            </div>
          ) : tab === 'archived' ? (
            <ArchivedChatsPanel
              projects={archived}
              onRefresh={refreshArchived}
              onSessionsChanged={onSessionsChanged}
            />
          ) : (
            <div className="settings-body"><RemotePairing onOpenHosts={onOpenHosts} /></div>
          )}
        </div>
      </div>
      <div className="modal-foot dim">
        {tab === 'appearance'
          ? '选择会保存在此设备，并立即应用到全部视图。'
          : tab === 'archived'
            ? '取消存档会把会话放回原项目分组；删除会同时移除 Scry 的 catalog、archive、附件、SQLite 与 usage 记录，不可恢复。'
            : '配对必须在被访问的主机上批准。请核对连接设备与待确认列表中显示的设备公钥指纹。'}
      </div>
    </ModalFrame>
  )
}

const archivedAtLabel = (ms?: number): string =>
  ms == null
    ? '存档时间未知'
    : `存档于 ${new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(ms))}`

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
          <b>已存档会话</b>
          <span>存档后会话从左侧列表移出，Scry 记录的轮次、用量与 trace 都保留。在这里可以取消存档放回原项目，或永久删除。</span>
        </div>
        <button
          type="button"
          className="arch-danger"
          disabled={total === 0 || busy}
          onClick={() => void deleteAll()}
        >
          <Icon name="trash" /> 全部删除
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
            <b>没有已存档会话</b>
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
                      onClick={() => void deleteOne(project.cwd, session)}
                    >
                      <Icon name="trash" />
                    </button>
                    <button
                      type="button"
                      className="arch-unarch"
                      disabled={busy}
                      onClick={() => void unarchive(project.cwd, session)}
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

type InventoryState = 'enabled' | 'disabled' | 'connected' | 'pending' | 'failed' | 'needs-auth' | 'required' | 'passed' | 'unknown' | 'unsupported'

interface EvidenceValue {
  state: InventoryState
  label: string
  detail?: string
  role?: 'alert' | 'status'
}

function EvidenceState({ value, quiet = false }: { value: EvidenceValue; quiet?: boolean }) {
  return (
    <span
      className={'inventory-state inventory-state--' + value.state + (quiet ? ' inventory-state--quiet' : '')}
      data-semantic-state={value.state}
      title={value.detail ?? value.label}
      role={value.role}
      aria-live={value.role ? 'polite' : undefined}
    >
      <i aria-hidden="true" />
      <span>{value.label}</span>
    </span>
  )
}

function scopeClass(scope: string): string {
  return scope === 'project' || scope === '.mcp.json' ? 'project' : scope === 'user' ? 'user' : 'unknown'
}

function scopeShortLabel(scope: string): string {
  return scope === 'project' || scope === '.mcp.json' ? '项目' : scope === 'user' ? '用户' : scope || '未知'
}

type SkillScopeFilter = 'project' | 'user' | 'provider'

function skillMatchesScope(skill: SkillMeta, scope: SkillScopeFilter): boolean {
  if (scope === 'project') return skill.scope === 'project'
  if (scope === 'user') return skill.scope === 'user'
  return skill.scope !== 'project' && skill.scope !== 'user'
}

export function filterSkillsForScope(skills: SkillMeta[], scope: SkillScopeFilter, query = ''): SkillMeta[] {
  const normalizedQuery = query.trim().toLowerCase()
  return skills.filter((skill) =>
    skillMatchesScope(skill, scope) &&
    (!normalizedQuery || [skill.name, skill.description, skill.dir].some((value) => value.toLowerCase().includes(normalizedQuery)))
  )
}

function observedTime(observedAt: number | undefined): string {
  if (!observedAt) return '尚未观测'
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(observedAt)
}

function InventoryContext({
  capability,
  kind,
  summary
}: {
  capability?: CapabilityEnvelope<unknown> | null
  kind: 'Skills' | 'MCP'
  summary: string
}) {
  const provider = capability?.providerId ?? 'Provider 未知'
  const cwd = capability?.cwd || '不绑定项目'
  return (
    <div className="inventory-context" aria-label={`${kind} 查询上下文`}>
      <div className="inventory-context__item">
        <span>Provider</span>
        <strong>{provider}</strong>
      </div>
      <i className="inventory-context__divider" aria-hidden="true" />
      <div className="inventory-context__item inventory-context__cwd">
        <span>工作目录</span>
        <code title={cwd}>{cwd}</code>
      </div>
      <span className="inventory-context__spacer" />
      <b className="inventory-context__summary">{summary}</b>
      <time className="inventory-context__time" dateTime={capability?.observedAt ? new Date(capability.observedAt).toISOString() : undefined}>
        {observedTime(capability?.observedAt)}
      </time>
    </div>
  )
}

export function SkillsModal({
  skills,
  capability,
  refreshing = false,
  onRefresh,
  onClose
}: {
  skills: SkillMeta[]
  capability?: CapabilityEnvelope<SkillMeta[]> | null
  refreshing?: boolean
  onRefresh: () => void
  onClose: () => void
}) {
  const titleId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const initialScope: SkillScopeFilter = skills.some((skill) => skill.scope === 'project')
    ? 'project'
    : skills.some((skill) => skill.scope === 'user')
      ? 'user'
      : skills.length > 0
        ? 'provider'
        : 'project'
  const [scope, setScope] = useState<SkillScopeFilter>(initialScope)
  const scopeChosenRef = useRef(false)
  const [query, setQuery] = useState('')
  const scopeSkills = filterSkillsForScope(skills, scope)
  const filtered = filterSkillsForScope(skills, scope, query)
  const projectCount = skills.filter((skill) => skill.scope === 'project').length
  const userCount = skills.filter((skill) => skill.scope === 'user').length
  const providerCount = skills.length - projectCount - userCount
  const scopeLabel = scope === 'project' ? '项目 Skill' : scope === 'user' ? '用户 Skill' : 'Provider Skill'
  const visibleScopes: SkillScopeFilter[] = providerCount > 0
    ? ['project', 'user', 'provider']
    : ['project', 'user']
  useEffect(() => {
    if (!visibleScopes.includes(scope)) {
      setScope(projectCount > 0 ? 'project' : 'user')
      return
    }
    if (scopeChosenRef.current || skills.length === 0 || filterSkillsForScope(skills, scope).length > 0) return
    setScope(projectCount > 0 ? 'project' : userCount > 0 ? 'user' : 'provider')
  }, [projectCount, providerCount, scope, skills, userCount])
  const chooseScope = (next: SkillScopeFilter): void => {
    scopeChosenRef.current = true
    setScope(next)
  }
  const onScopeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const current = visibleScopes.indexOf(scope)
    const next = event.key === 'Home'
      ? visibleScopes[0]
      : event.key === 'End'
        ? visibleScopes.at(-1)
        : event.key === 'ArrowRight'
          ? visibleScopes[(current + 1) % visibleScopes.length]
          : event.key === 'ArrowLeft'
            ? visibleScopes[(current - 1 + visibleScopes.length) % visibleScopes.length]
            : undefined
    if (!next) return
    event.preventDefault()
    chooseScope(next)
    window.requestAnimationFrame(() => document.getElementById(`${titleId}-${next}-tab`)?.focus())
  }
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={searchRef} className="skills-modal inventory-modal inventory-modal--skills" onClose={onClose}>
      <div className="modal-head inventory-modal__head">
        <div className="inventory-modal__title">
          <span className="inventory-modal__eyebrow">Capability inventory</span>
          <div className="inventory-modal__title-line">
            <b id={titleId}>Skills</b>
            {capability?.providerId && <span className="inventory-provider">{capability.providerId}</span>}
          </div>
          <p>查看当前 Provider 在这个工作目录里实际发现了哪些 Skill。</p>
        </div>
        <div className="inventory-modal__head-actions">
          {refreshing && <EvidenceState value={{ state: 'pending', label: '读取中…', role: 'status' }} quiet />}
          <button className="modal-refresh" onClick={onRefresh} disabled={refreshing} title="重新读取当前 Provider 的 Skill 清单" aria-label="刷新 Skills">
            <Icon name="refresh" />
          </button>
          <button className="modal-x" onClick={onClose} aria-label="关闭 Skills"><Icon name="x" /></button>
        </div>
      </div>

      <InventoryContext
        capability={capability}
        kind="Skills"
        summary={`${filtered.length} 个结果`}
      />

      {capability && capability.state !== 'ready' && (
        <div className="inventory-capability-note" role={capability.state === 'unknown' ? 'alert' : 'status'}>
          {capability.reason ?? capability.state}
        </div>
      )}

      <div className="skill-scope-tabs" role="tablist" aria-label="Skill 来源">
        <button
          type="button"
          id={titleId + '-project-tab'}
          role="tab"
          tabIndex={scope === 'project' ? 0 : -1}
          aria-selected={scope === 'project'}
          aria-controls={titleId + '-skills-panel'}
          className={scope === 'project' ? 'active' : ''}
          onClick={() => chooseScope('project')}
          onKeyDown={onScopeKeyDown}
        >
          项目 Skill <span>{projectCount}</span>
        </button>
        <button
          type="button"
          id={titleId + '-user-tab'}
          role="tab"
          tabIndex={scope === 'user' ? 0 : -1}
          aria-selected={scope === 'user'}
          aria-controls={titleId + '-skills-panel'}
          className={scope === 'user' ? 'active' : ''}
          onClick={() => chooseScope('user')}
          onKeyDown={onScopeKeyDown}
        >
          用户 Skill <span>{userCount}</span>
        </button>
        {providerCount > 0 && (
          <button
            type="button"
            id={titleId + '-provider-tab'}
            role="tab"
            tabIndex={scope === 'provider' ? 0 : -1}
            aria-selected={scope === 'provider'}
            aria-controls={titleId + '-skills-panel'}
            className={scope === 'provider' ? 'active' : ''}
            onClick={() => chooseScope('provider')}
            onKeyDown={onScopeKeyDown}
          >
            Provider Skill <span>{providerCount}</span>
          </button>
        )}
      </div>

      <div className="inventory-toolbar">
        <label className="inventory-search">
          <span>搜索</span>
          <input
            ref={searchRef}
            type="search"
            className="modal-search"
            placeholder={`搜索${scopeLabel}`}
            aria-label="搜索 Skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">清除</button>}
        </label>
        <span className="inventory-toolbar__count" aria-live="polite">显示 {filtered.length} / {scopeSkills.length}</span>
      </div>

      <div
        className="modal-body inventory-modal__body"
        id={titleId + '-skills-panel'}
        role="tabpanel"
        aria-labelledby={titleId + '-' + scope + '-tab'}
      >
        {filtered.length === 0 && (
          <div className="inventory-empty" role="status">
            <strong>{refreshing && skills.length === 0 ? '正在读取 Skill…' : scopeSkills.length === 0 ? `未发现${scopeLabel}` : `${scopeLabel}中没有匹配结果`}</strong>
            <p>{scopeSkills.length === 0 ? `当前 Provider 没有返回${scopeLabel}。` : '换一个关键词，或清空搜索查看全部条目。'}</p>
            {query && <button type="button" onClick={() => setQuery('')}>清空搜索</button>}
          </div>
        )}

        {filtered.length > 0 && (
          <div className="skill-ledger">
            {filtered.map((skill) => (
              <article className="skill-ledger__row" key={skill.scope + ':' + skill.name}>
                <div className="skill-ledger__main">
                  <div className="skill-ledger__name-line">
                    <strong>{skill.name}</strong>
                    <span className={'inventory-scope inventory-scope--' + scopeClass(skill.scope)}>{scopeShortLabel(skill.scope)}</span>
                  </div>
                  <p title={skill.description}>{skill.description}</p>
                  <div className="skill-ledger__source"><span>来源</span><code title={skill.dir}>{skill.dir}</code></div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="modal-foot inventory-footnote">
        <span>发现证据</span>
        <p>清单直接来自当前 Provider 在这个工作目录的发现结果，Scry 只读取、不改写 Skill 配置。</p>
      </div>
    </ModalFrame>
  )
}

const MCP_SCOPE_LABEL: Record<string, string> = {
  '.mcp.json': '项目 MCP（.mcp.json）',
  project: '项目 MCP（~/.claude.json）',
  user: '用户 MCP（~/.claude.json）',
  effective: 'Pi 有效配置（合并后）'
}

const LIVE_STATE: Record<McpLiveStatus['status'], InventoryState> = {
  connected: 'connected',
  cached: 'unknown',
  disconnected: 'unknown',
  failed: 'failed',
  'needs-auth': 'needs-auth',
  'needs-client-registration': 'required',
  pending: 'pending',
  disabled: 'disabled'
}

const LIVE_TEXT: Record<McpLiveStatus['status'], string> = {
  connected: '已连接',
  cached: '仅缓存元数据',
  disconnected: '尚未连接',
  failed: '连接失败',
  'needs-auth': '需要认证',
  'needs-client-registration': '需配置 OAuth Client',
  pending: '连接中',
  disabled: '已关闭'
}

function evidenceForRuntime(value: McpLiveStatus | undefined, capability: CapabilityEnvelope<McpSnapshot> | null | undefined): EvidenceValue {
  if (!value) {
    if (capability?.state === 'unsupported' || capability?.mode === 'none') {
      return { state: 'unsupported', label: '不支持', detail: capability.reason ?? 'Provider 不提供 MCP 运行态' }
    }
    return {
      state: 'unknown',
      label: '未知',
      detail: capability?.data?.runtime === null ? '尚未探测 Provider 运行态' : 'Provider 未返回此 Server 的运行态'
    }
  }
  const state = LIVE_STATE[value.status]
  if (!state) return { state: 'unknown', label: value.status || 'unknown', detail: 'Provider 返回了未识别的运行态' }
  return {
    state,
    label: LIVE_TEXT[value.status],
    detail: value.status === 'cached'
      ? 'Provider 仅返回缓存中的工具元数据；这不是实时连接证据'
      : value.status === 'disconnected'
        ? 'Provider 已加载配置，但 lazy server 尚未建立连接'
        : value.serverName || value.serverVersion
          ? [value.serverName, value.serverVersion].filter(Boolean).join(' · ')
          : '来自当前 Provider 原生运行时'
  }
}

/* 操作列很窄：内联槽位只放短结论，完整证据走 title */
function shortTestLabel(value: EvidenceValue): string {
  if (value.state === 'passed') return '本次测试通过'
  if (value.state === 'pending') return '测试中…'
  if (value.state === 'needs-auth') return '测试无 OAuth token'
  return value.detail?.replace('本次测试失败 · ', '测试失败 · ') ?? '本次测试失败'
}

function McpEvidenceCell({ label, value, className = '' }: { label: string; value: EvidenceValue; className?: string }) {
  return (
    <div className={'mcp-evidence-cell' + (className ? ' ' + className : '')}>
      <span className="mcp-evidence-cell__label">{label}</span>
      <EvidenceState value={value} />
      {value.detail && <small>{value.detail}</small>}
    </div>
  )
}

export function McpModal({
  mcps,
  status,
  live,
  configRefreshing = false,
  refreshing,
  capability,
  onTest,
  onReauthenticate,
  onRefresh,
  onClose
}: {
  mcps: McpMeta[]
  status: Record<string, McpStatus>
  live: McpLiveStatus[]
  configRefreshing?: boolean
  refreshing: boolean
  capability?: CapabilityEnvelope<McpSnapshot> | null
  onTest: (targetId: string) => void
  onReauthenticate?: (targetId: string) => void
  onRefresh: () => void
  onClose: () => void
}) {
  const canManage = capability?.mode === 'manage'
  const readsRuntime = capability?.mode === 'read'
  const readsPiSnapshot = readsRuntime && capability?.providerId === 'pi'
  const refreshLabel = readsPiSnapshot ? '刷新快照' : '检测全部'
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const loadingConfig = configRefreshing && !capability
  const loading = loadingConfig || refreshing
  const authenticationInProgress = Object.values(status).some((item) => item.authenticating)
  const [expanded, setExpanded] = useState<string | null>(null)
  const liveByName = new Map(live.map((item) => [item.name, item]))
  const connectedCount = live.filter((item) => item.status === 'connected').length
  const testEvidenceCount = Object.values(status).filter((item) => item.ok != null || item.testing).length

  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={closeRef} className="inventory-modal inventory-modal--mcp" onClose={onClose}>
      <div className="modal-head inventory-modal__head">
        <div className="inventory-modal__title">
          <span className="inventory-modal__eyebrow">Capability fleet</span>
          <div className="inventory-modal__title-line">
            <b id={titleId}>MCP</b>
            {capability?.providerId && <span className="inventory-provider">{capability.providerId}</span>}
          </div>
        </div>
        <div className="inventory-modal__head-actions">
          {loading && <EvidenceState value={{ state: 'pending', label: loadingConfig ? '读取配置中…' : readsPiSnapshot ? '正在刷新 Pi MCP 快照…' : '正在检测全部 MCP…', role: 'status' }} quiet />}
          <button
            className={'modal-refresh' + (readsRuntime ? ' mcp-refresh-all' : '')}
            onClick={onRefresh}
            disabled={loading || authenticationInProgress}
            title={readsPiSnapshot
              ? '重新读取 Pi 脱敏后的有效配置与原生 lazy/runtime 状态；不会主动连接 lazy server'
              : readsRuntime
                ? '启动已授权 MCP，并刷新当前 Provider 的全部原生运行状态'
                : '重新读取当前 Provider 的原生 MCP 配置与运行状态'}
            aria-label={readsPiSnapshot ? '刷新 Pi MCP 快照' : readsRuntime ? '检测全部 MCP 运行状态' : '刷新 MCP 状态'}
          >
            {refreshing && readsRuntime ? <span className="spinner" /> : <Icon name="refresh" />}
            {readsRuntime && <span>{refreshing ? (readsPiSnapshot ? '刷新中…' : '检测中…') : refreshLabel}</span>}
          </button>
          <button ref={closeRef} className="modal-x" onClick={onClose} aria-label="关闭 MCP"><Icon name="x" /></button>
        </div>
      </div>

      <InventoryContext
        capability={capability}
        kind="MCP"
        summary={`${mcps.length} 配置 · ${live.length > 0 ? connectedCount + ' 已连接 / ' + live.length + ' 运行态' : '运行态未返回'} · ${testEvidenceCount} 测试证据`}
      />

      {capability && capability.state !== 'ready' && (
        <div className="inventory-capability-note" role={capability.state === 'unknown' ? 'alert' : 'status'}>
          {capability.reason ?? capability.state}
        </div>
      )}

      <div className="inventory-state-legend" aria-label="状态语义说明">
        <span>状态语义</span>
        <EvidenceState value={{ state: 'unknown', label: '未知：还没有证据' }} quiet />
        <EvidenceState value={{ state: 'unsupported', label: '不支持：能力不存在' }} quiet />
      </div>

      <div className="modal-body inventory-modal__body inventory-modal__body--mcp">
        {mcps.length === 0 ? (
          <div className="inventory-empty" role="status">
            <strong>{loadingConfig ? '正在读取 MCP 配置…' : '未发现 MCP 配置'}</strong>
            <p>{loadingConfig ? '等待当前 Provider 返回配置清单。' : '没有配置证据不等于运行正常，也不等于连接失败。'}</p>
          </div>
        ) : (
          <div className="mcp-fleet-wrap">
            <table className="mcp-fleet">
              <caption className="inventory-sr-only">MCP Fleet：Provider 运行态与认证独立展示</caption>
              <thead>
                <tr>
                  <th scope="col">Server / 来源</th>
                  <th scope="col">Provider 运行态</th>
                  <th scope="col">认证</th>
                  <th scope="col"><span className="inventory-sr-only">操作</span></th>
                </tr>
              </thead>
              {mcps.map((mcp, index) => {
                const targetId = mcp.targetId ?? mcp.name
                const currentStatus = status[targetId]
                const runtime = liveByName.get(mcp.name)
                const runtimeValue = evidenceForRuntime(runtime, capability)
                const open = expanded === targetId
                const toolsId = titleId + '-tools-' + index
                const authLimited = currentStatus?.ok === false && /40[13]/.test(currentStatus.error ?? '')
                const canAuthenticate = Boolean(onReauthenticate && capability?.data?.operations?.authenticate.includes(targetId))
                const needsAuth = runtime?.status === 'needs-auth'
                const needsClientRegistration = runtime?.status === 'needs-client-registration'
                const hasTestEvidence = Boolean(currentStatus?.testing || currentStatus?.ok != null)

                let testValue: EvidenceValue
                if (currentStatus?.testing) {
                  testValue = { state: 'pending', label: '测试中', detail: '正在执行 initialize / tools/list…', role: 'status' }
                } else if (currentStatus?.ok === true) {
                  testValue = {
                    state: 'passed',
                    label: '通过',
                    detail: '本次测试成功' + (currentStatus.tools != null ? ' · ' + currentStatus.tools + ' tools' : ''),
                    role: 'status'
                  }
                } else if (currentStatus?.ok === false) {
                  testValue = authLimited
                    ? { state: 'needs-auth', label: '需认证（测试无 token）', detail: '测试握手没带 OAuth token；真实连接以当前 Provider 原生运行时为准', role: 'alert' }
                    : { state: 'failed', label: '失败', detail: '本次测试失败' + (currentStatus.error ? ' · ' + currentStatus.error : ''), role: 'alert' }
                } else if (canManage) {
                  testValue = { state: 'unknown', label: '未测试', detail: '尚未执行单项 initialize / tools/list' }
                } else if (readsRuntime || capability?.state === 'unsupported' || capability?.mode === 'none') {
                  testValue = { state: 'unsupported', label: '不支持单项直测', detail: '使用 Provider 原生运行态；Scry 不伪造测试结果' }
                } else {
                  testValue = { state: 'unknown', label: '未知', detail: '测试能力尚未确认' }
                }

                let authValue: EvidenceValue
                if (currentStatus?.authenticating) {
                  authValue = { state: 'pending', label: '认证中', detail: '等待浏览器完成授权…', role: 'status' }
                } else if (currentStatus?.authOk === true) {
                  authValue = currentStatus.authError
                    ? { state: 'pending', label: '已授权 · 待确认', detail: '授权流程已完成；运行状态未确认 · ' + currentStatus.authError, role: 'status' }
                    : { state: 'passed', label: '认证成功', detail: '认证成功，运行状态已刷新', role: 'status' }
                } else if (currentStatus?.authOk === false || currentStatus?.authError) {
                  authValue = { state: 'failed', label: '认证失败', detail: '认证失败' + (currentStatus.authError ? ' · ' + currentStatus.authError : ''), role: 'alert' }
                } else if (needsClientRegistration) {
                  authValue = { state: 'required', label: '需配置 OAuth Client', detail: '需在 Provider 中配置 OAuth Client ID' }
                } else if (needsAuth) {
                  authValue = { state: 'required', label: '需要认证', detail: canAuthenticate ? '可由 Scry 启动 Provider 原生 OAuth' : '请在 Provider 客户端完成认证' }
                } else if (capability?.data?.operations) {
                  authValue = capability.data.operations.authenticate.includes(targetId)
                    ? { state: 'unknown', label: '未执行', detail: '当前没有认证流程结果' }
                    : { state: 'unsupported', label: 'Scry 不支持', detail: 'Provider 未声明此目标可由 Scry 发起认证' }
                } else {
                  authValue = { state: 'unknown', label: '未知', detail: 'Provider 未返回认证能力证据' }
                }

                return (
                  <tbody key={mcp.scope + ':' + targetId}>
                    <tr className={'mcp-fleet__row mcp-fleet__row--' + runtimeValue.state}>
                      <th scope="row">
                        <div className="mcp-server-cell">
                          <div className="mcp-server-cell__name">
                            <strong>{mcp.name}</strong>
                            <span>{mcp.transport}</span>
                            <span className={'inventory-scope inventory-scope--' + scopeClass(mcp.scope)} title={MCP_SCOPE_LABEL[mcp.scope] ?? mcp.scope}>
                              {scopeShortLabel(mcp.scope)}
                            </span>
                            {!mcp.enabled && (
                              <span className="inventory-scope inventory-scope--off" title="配置文件中已关闭">已关闭</span>
                            )}
                          </div>
                          <code title={mcp.detail}>{mcp.detail}</code>
                          {currentStatus?.ok && currentStatus.toolNames && currentStatus.toolNames.length > 0 && (
                            <button
                              className="mcp-tools-toggle"
                              type="button"
                              aria-expanded={open}
                              aria-controls={toolsId}
                              onClick={() => setExpanded(open ? null : targetId)}
                            >
                              <span aria-hidden="true">{open ? '−' : '+'}</span>
                              {currentStatus.toolNames.length} tools
                            </button>
                          )}
                        </div>
                      </th>
                      <td><McpEvidenceCell label="运行态" value={runtimeValue} /></td>
                      <td><McpEvidenceCell label="认证" value={authValue} /></td>
                      <td className="mcp-fleet__actions">
                        {canManage && (
                          <button className="mcp-test" onClick={() => onTest(targetId)} disabled={currentStatus?.testing || authenticationInProgress}>
                            {currentStatus?.testing ? <><span className="spinner" /> 测试中…</> : '测试连接'}
                          </button>
                        )}
                        {needsAuth && canAuthenticate && (
                          <button
                            className="mcp-test"
                            onClick={() => onReauthenticate?.(targetId)}
                            disabled={authenticationInProgress}
                            aria-label={'重新认证 MCP ' + mcp.name}
                          >
                            {currentStatus?.authenticating ? <><span className="spinner" /> 认证中…</> : '重新认证'}
                          </button>
                        )}
                        {hasTestEvidence && (
                          <div className={'mcp-test-inline mcp-test-inline--' + testValue.state} title={testValue.detail} role={testValue.role}>
                            <i aria-hidden="true" />
                            <span>{shortTestLabel(testValue)}</span>
                          </div>
                        )}
                        {needsClientRegistration ? (
                          <small>需在 Provider 中配置 OAuth Client ID</small>
                        ) : needsAuth && !canAuthenticate ? (
                          <small>请在 Provider 客户端完成认证</small>
                        ) : null}
                      </td>
                    </tr>
                    {open && currentStatus?.toolNames && (
                      <tr className="mcp-tools-row">
                        <td colSpan={4}>
                          <div id={toolsId} className="mcp-tools-drawer">
                            <div><strong>本次测试返回的工具</strong><small>来自 initialize / tools/list</small></div>
                            <div className="mcp-tools-drawer__list">
                              {currentStatus.toolNames.map((tool) => <code key={tool}>{tool}</code>)}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                )
              })}
            </table>
          </div>
        )}
      </div>

      <div className="modal-foot inventory-footnote">
        <span>证据边界</span>
        <p>
          {capability?.data?.operations?.authenticate.length
            ? '支持认证的远程 MCP 可直接在 Scry 完成 Provider 原生 OAuth；凭据由 Provider 保存在本机（OpenCode 使用 Scry 私有目录），不会上传。'
            : canManage
              ? '当前 Provider 支持由 Scry 直测单个 MCP 连接。'
              : capability?.mode === 'read'
                ? '当前 Provider 只暴露原生 MCP 配置/运行状态，不提供单项直测；使用顶部「检测全部」读取原生运行状态。'
                : '当前 Provider 没有可用的 MCP 配置/运行状态接口。'}
        </p>
      </div>
    </ModalFrame>
  )
}

type CapabilityView = 'skills' | 'mcp'
type CapabilitySource = 'all' | 'project' | 'user'

function CapabilitySourceTabs({
  source,
  onChange,
  label
}: {
  source: CapabilitySource
  onChange: (source: CapabilitySource) => void
  label: string
}) {
  return (
    <div className="capability-source-tabs" role="tablist" aria-label={label}>
      {(['all', 'project', 'user'] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={source === value}
          className={source === value ? 'active' : ''}
          onClick={() => onChange(value)}
        >
          {value === 'all' ? '全部' : value === 'project' ? '项目' : '用户'}
        </button>
      ))}
    </div>
  )
}

export function CapabilitiesModal({
  view,
  onViewChange,
  skills,
  skillCapability,
  skillsRefreshing = false,
  mcps,
  status,
  live,
  mcpConfigRefreshing = false,
  mcpRefreshing,
  mcpCapability,
  onTestMcp,
  onReauthenticateMcp,
  onRefreshMcp,
  onClose
}: {
  view: CapabilityView
  onViewChange: (view: CapabilityView) => void
  skills: SkillMeta[]
  skillCapability?: CapabilityEnvelope<SkillMeta[]> | null
  skillsRefreshing?: boolean
  mcps: McpMeta[]
  status: Record<string, McpStatus>
  live: McpLiveStatus[]
  mcpConfigRefreshing?: boolean
  mcpRefreshing: boolean
  mcpCapability?: CapabilityEnvelope<McpSnapshot> | null
  onTestMcp: (targetId: string) => void
  onReauthenticateMcp?: (targetId: string) => void
  onRefreshMcp: () => void
  onClose: () => void
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [source, setSource] = useState<CapabilitySource>('all')
  const [expandedMcp, setExpandedMcp] = useState<string | null>(null)
  const activeCapability = view === 'skills' ? skillCapability : mcpCapability
  const loadingMcpConfig = mcpConfigRefreshing && !mcpCapability
  const loadingMcp = loadingMcpConfig || mcpRefreshing
  const authenticationInProgress = Object.values(status).some((item) => item.authenticating)
  const liveByName = new Map(live.map((item) => [item.name, item]))
  const visibleSkills = source === 'all' ? skills : skills.filter((skill) => skill.scope === source)
  const visibleMcps = source === 'all'
    ? mcps
    : mcps.filter((mcp) => (mcp.scope === 'user' ? 'user' : 'project') === source)

  const chooseView = (nextView: CapabilityView): void => {
    setSource('all')
    setExpandedMcp(null)
    onViewChange(nextView)
  }

  return (
    <ModalFrame
      labelledBy={titleId}
      initialFocusRef={closeRef}
      className={`capabilities-modal capabilities-modal--${view}`}
      onClose={onClose}
    >
      <div className="capabilities-head">
        <h2 id={titleId} className="inventory-sr-only">Capabilities</h2>
        <div className="capability-kind-tabs" role="tablist" aria-label="能力类型">
          <button type="button" role="tab" aria-selected={view === 'skills'} className={view === 'skills' ? 'active' : ''} onClick={() => chooseView('skills')}>Skills</button>
          <button type="button" role="tab" aria-selected={view === 'mcp'} className={view === 'mcp' ? 'active' : ''} onClick={() => chooseView('mcp')}>MCP</button>
        </div>
        <span className="capabilities-head__spacer" />
        {view === 'mcp' && (
          <button
            className="capabilities-refresh"
            type="button"
            onClick={onRefreshMcp}
            disabled={loadingMcp || authenticationInProgress}
            aria-label="刷新 MCP 运行状态"
          >
            {mcpRefreshing ? <span className="spinner" /> : <Icon name="refresh" />}
            <span>{mcpRefreshing ? '检测中…' : '刷新'}</span>
          </button>
        )}
        <button ref={closeRef} className="modal-x capabilities-close" onClick={onClose} aria-label="关闭能力面板"><Icon name="x" /></button>
      </div>

      <div className="capabilities-source-bar">
        <CapabilitySourceTabs
          source={source}
          onChange={(nextSource) => {
            setSource(nextSource)
            setExpandedMcp(null)
          }}
          label={view === 'skills' ? 'Skill 来源' : 'MCP 来源'}
        />
      </div>

      {activeCapability && activeCapability.state !== 'ready' && (
        <div className="inventory-capability-note" role={activeCapability.state === 'unknown' ? 'alert' : 'status'}>
          {activeCapability.reason ?? activeCapability.state}
        </div>
      )}

      {view === 'skills' ? (
        <div className="capabilities-body capabilities-skills" role="tabpanel">
          {visibleSkills.length > 0 ? visibleSkills.map((skill) => (
            <article className="capability-skill" key={skill.scope + ':' + skill.name}>
              <strong>{skill.name}</strong>
              <p title={skill.description}>{skill.description}</p>
            </article>
          )) : (
            <div className="capabilities-empty" role="status">
              <strong>{skillsRefreshing && skills.length === 0 ? '正在读取 Skill…' : '当前来源没有 Skill'}</strong>
              <span>{skillsRefreshing && skills.length === 0 ? '等待当前 Provider 返回发现结果。' : '切换其他来源查看。'}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="capabilities-body capability-mcp-list" role="tabpanel">
          {visibleMcps.length > 0 ? visibleMcps.map((mcp) => {
            const targetId = mcp.targetId ?? mcp.name
            const runtime = liveByName.get(mcp.name)
            const currentStatus = status[targetId]
            const runtimeValue: EvidenceValue = !mcp.enabled
              ? { state: 'disabled', label: '已关闭', detail: '配置文件中的当前值' }
              : evidenceForRuntime(runtime, mcpCapability)
            const toolNames = runtime?.toolNames ?? currentStatus?.toolNames
            const canLoadTools = mcp.enabled && runtime?.status === 'connected' && mcpCapability?.mode === 'manage'
            const expandable = Boolean(mcp.enabled && runtime?.status === 'connected' && (toolNames?.length || canLoadTools))
            const open = expandedMcp === targetId
            const canAuthenticate = Boolean(onReauthenticateMcp && mcpCapability?.data?.operations?.authenticate.includes(targetId))
            const needsAuth = runtime?.status === 'needs-auth'
            const authLabel = currentStatus?.authenticating
              ? '认证中…'
              : currentStatus?.authOk === false
                ? '认证失败，重试'
                : currentStatus?.authOk && currentStatus.authError
                  ? '认证待确认'
                  : '需要认证'

            const toggleTools = (): void => {
              const nextOpen = !open
              setExpandedMcp(nextOpen ? targetId : null)
              if (nextOpen && !toolNames?.length && canLoadTools && !currentStatus?.testing) onTestMcp(targetId)
            }

            return (
              <article className={`capability-mcp-row capability-mcp-row--${runtimeValue.state}`} key={mcp.scope + ':' + targetId}>
                <div className="capability-mcp-row__summary">
                  <div className="capability-mcp-server">
                    <div className="capability-mcp-server__name">
                      {expandable ? (
                        <button type="button" className="capability-mcp-toggle" aria-expanded={open} onClick={toggleTools}>
                          <span aria-hidden="true">{open ? '⌄' : '›'}</span>
                          <strong>{mcp.name}</strong>
                        </button>
                      ) : (
                        <strong className="capability-mcp-static">{mcp.name}</strong>
                      )}
                      <span>{mcp.transport}</span>
                    </div>
                    <code title={mcp.detail}>{mcp.detail}</code>
                  </div>
                  <div className="capability-mcp-runtime">
                    {needsAuth && canAuthenticate ? (
                      <button
                        type="button"
                        className={`capability-auth capability-auth--${currentStatus?.authOk === false ? 'failed' : 'required'}`}
                        onClick={() => onReauthenticateMcp?.(targetId)}
                        disabled={authenticationInProgress}
                        title={currentStatus?.authError ?? runtimeValue.detail}
                      >
                        {currentStatus?.authenticating && <span className="spinner" />}
                        {!currentStatus?.authenticating && <i aria-hidden="true" />}
                        {authLabel}
                      </button>
                    ) : (
                      <EvidenceState value={runtimeValue} />
                    )}
                  </div>
                </div>
                {expandable && (
                  <div className={`capability-tools ${open ? 'open' : ''}`}>
                    <div className="capability-tools__inner">
                      {currentStatus?.testing ? (
                        <span className="capability-tools__message">正在读取工具明细…</span>
                      ) : toolNames?.length ? (
                        <div className="capability-tools__list">{toolNames.map((tool) => <code key={tool}>{tool}</code>)}</div>
                      ) : currentStatus?.ok === false ? (
                        <span className="capability-tools__message capability-tools__message--error">工具明细读取失败 · {currentStatus.error}</span>
                      ) : (
                        <span className="capability-tools__message">Provider 未返回工具名称明细</span>
                      )}
                    </div>
                  </div>
                )}
              </article>
            )
          }) : (
            <div className="capabilities-empty" role="status">
              <strong>{loadingMcpConfig ? '正在读取 MCP 配置…' : '当前来源没有 MCP'}</strong>
              <span>{loadingMcpConfig ? '等待当前 Provider 返回配置清单。' : '切换其他来源查看。'}</span>
            </div>
          )}
        </div>
      )}
    </ModalFrame>
  )
}
