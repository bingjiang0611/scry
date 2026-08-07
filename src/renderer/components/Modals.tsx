// 全局弹窗：设置 / Skills 证据账本 / MCP Fleet。
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { McpStatus } from '../format'
import type { SkillMeta, McpMeta } from '../env'
import type { McpLiveStatus } from '@shared/trace'
import type { CapabilityEnvelope, McpSnapshot } from '@shared/provider'
import { Icon } from './primitives/Icon'
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
    const frame = window.requestAnimationFrame(() => {
      const requested = initialFocusRef?.current
      const target = requested && !requested.matches(':disabled') ? requested : focusable()[0] ?? dialogRef.current
      target?.focus()
    })
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
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
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

export function SettingsModal({
  theme,
  onThemeChange,
  onClose
}: {
  theme: AppTheme
  onThemeChange: (theme: AppTheme) => void
  onClose: () => void
}) {
  const titleId = useId()
  const darkRef = useRef<HTMLButtonElement>(null)
  const lightRef = useRef<HTMLButtonElement>(null)
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={theme === 'dark' ? darkRef : lightRef} className="settings-modal" onClose={onClose}>
      <div className="modal-head">
        <b id={titleId}>设置</b>
        <button className="modal-x" onClick={onClose} aria-label="关闭设置">
          <Icon name="x" />
        </button>
      </div>
      <div className="settings-body">
        <div className="settings-copy">
          <b>外观</b>
          <span>选择 Scry 的全局界面主题。</span>
        </div>
        <div className="theme-options" role="radiogroup" aria-label="界面主题">
          <button
            ref={darkRef}
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
            ref={lightRef}
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
      <div className="modal-foot dim">选择会保存在此设备，并立即应用到全部视图。</div>
    </ModalFrame>
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

function InventorySwitch({
  checked,
  disabled,
  label,
  title,
  onChange,
  className = ''
}: {
  checked: boolean
  disabled: boolean
  label: string
  title?: string
  onChange: (checked: boolean) => void
  className?: string
}) {
  return (
    <label className={'inventory-switch' + (className ? ' ' + className : '')} title={title}>
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="inventory-switch__track" aria-hidden="true"><span /></span>
    </label>
  )
}

function scopeClass(scope: string): string {
  return scope === 'project' || scope === '.mcp.json' ? 'project' : scope === 'user' ? 'user' : 'unknown'
}

function scopeShortLabel(scope: string): string {
  return scope === 'project' || scope === '.mcp.json' ? '项目' : scope === 'user' ? '用户' : scope || '未知'
}

export function SkillsModal({
  skills,
  capability,
  refreshing = false,
  onToggle,
  onRefresh,
  onClose
}: {
  skills: SkillMeta[]
  capability?: CapabilityEnvelope<SkillMeta[]> | null
  refreshing?: boolean
  onToggle: (name: string, enabled: boolean) => void
  onRefresh: () => void
  onClose: () => void
}) {
  const canManage = capability?.mode === 'manage'
  const titleId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = normalizedQuery
    ? skills.filter((skill) => [skill.name, skill.description, skill.dir, skill.scope].some((value) => value.toLowerCase().includes(normalizedQuery)))
    : skills
  const groups: Record<string, SkillMeta[]> = {}
  for (const skill of filtered) (groups[skill.scope] ??= []).push(skill)
  const scopes = ['project', 'user', ...Object.keys(groups).filter((scope) => scope !== 'project' && scope !== 'user')]
  const manageDetail = canManage
    ? 'Scry 可写入当前 Provider 的 Skill 配置'
    : capability?.mode === 'read'
      ? 'Provider 原生状态 · Scry 只读'
      : capability?.state === 'unsupported' || capability?.mode === 'none'
        ? '当前 Provider 不支持由 Scry 管理'
        : '管理能力尚未确认'

  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={searchRef} className="skills-modal inventory-modal inventory-modal--skills" onClose={onClose}>
      <div className="modal-head inventory-modal__head">
        <div className="inventory-modal__title">
          <span className="inventory-modal__eyebrow">Capability inventory</span>
          <div className="inventory-modal__title-line">
            <b id={titleId}>Skills</b>
            {capability?.providerId && <span className="inventory-provider">{capability.providerId}</span>}
          </div>
          <p>查看当前 Provider 在这个工作目录里实际发现了什么，以及 Scry 是否有权管理它。</p>
        </div>
        <div className="inventory-modal__head-actions">
          {refreshing && <EvidenceState value={{ state: 'pending', label: '读取中…', role: 'status' }} quiet />}
          <button className="modal-refresh" onClick={onRefresh} disabled={refreshing} title="重新读取当前 Provider 的 Skill 状态" aria-label="刷新 Skills">
            <Icon name="refresh" />
          </button>
          <button className="modal-x" onClick={onClose} aria-label="关闭 Skills"><Icon name="x" /></button>
        </div>
      </div>

      {capability && capability.state !== 'ready' && (
        <div className="inventory-capability-note" role={capability.state === 'unknown' ? 'alert' : 'status'}>
          {capability.reason ?? capability.state}
        </div>
      )}

      <div className="inventory-toolbar">
        <label className="inventory-search">
          <span>搜索</span>
          <input
            ref={searchRef}
            type="search"
            className="modal-search"
            placeholder="名称、描述、来源或 scope"
            aria-label="搜索 Skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">清除</button>}
        </label>
        <span className="inventory-toolbar__count" aria-live="polite">显示 {filtered.length} / {skills.length}</span>
      </div>

      <div className="modal-body inventory-modal__body">
        {filtered.length === 0 && (
          <div className="inventory-empty" role="status">
            <strong>{refreshing && skills.length === 0 ? '正在读取 Skill…' : skills.length === 0 ? '未发现 Skill' : '没有匹配的 Skill'}</strong>
            <p>{skills.length === 0 ? '当前 Provider 与工作目录没有返回 Skill 条目。' : '换一个关键词，或清空搜索查看全部条目。'}</p>
            {query && <button type="button" onClick={() => setQuery('')}>清空搜索</button>}
          </div>
        )}

        {scopes.map((scope) => {
          const list = groups[scope]
          if (!list?.length) return null
          const groupLabel = scope === 'project' ? '项目 Skills' : scope === 'user' ? '用户 Skills' : (scope || '来源未知') + ' Skills'
          const groupHint = scope === 'project' ? '随当前仓库生效' : scope === 'user' ? '来自用户目录，可跨项目复用' : 'Provider 返回的原始 scope'
          const groupId = titleId + '-skills-' + (scope || 'unknown')
          return (
            <section className="skill-group" key={scope} aria-labelledby={groupId}>
              <div className="skill-group__head">
                <div><h2 id={groupId}>{groupLabel}</h2><p>{groupHint}</p></div>
                <span>{list.length}</span>
              </div>
              <div className="skill-ledger">
                {list.map((skill) => {
                  const configValue: EvidenceValue = {
                    state: skill.enabled ? 'enabled' : 'disabled',
                    label: skill.enabled ? '已启用' : '已关闭',
                    detail: manageDetail
                  }
                  return (
                    <article className="skill-ledger__row" key={skill.scope + ':' + skill.name}>
                      <InventorySwitch
                        checked={skill.enabled}
                        disabled={!canManage}
                        label={(skill.enabled ? '关闭' : '启用') + ' Skill ' + skill.name}
                        title={manageDetail}
                        onChange={(enabled) => onToggle(skill.name, enabled)}
                        className="skill-switch"
                      />
                      <div className="skill-ledger__main">
                        <div className="skill-ledger__name-line">
                          <strong>{skill.name}</strong>
                          <span className={'inventory-scope inventory-scope--' + scopeClass(scope)}>{scopeShortLabel(scope)}</span>
                        </div>
                        <p title={skill.description}>{skill.description}</p>
                        <div className="skill-ledger__source"><span>来源</span><code title={skill.dir}>{skill.dir}</code></div>
                      </div>
                      <div className="skill-ledger__status">
                        <span>配置状态</span>
                        <EvidenceState value={configValue} />
                        <small>{canManage ? '可管理' : capability?.mode === 'read' ? '只读' : capability?.state === 'unsupported' || capability?.mode === 'none' ? '不支持管理' : '管理能力未知'}</small>
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>

      <div className="modal-foot inventory-footnote">
        <span>配置证据</span>
        <p>{canManage ? '当前 Provider 支持由 Scry 管理 Skill 开关。' : '当前 Provider 的 Skill 目录仅供读取；Scry 不修改其私有配置。'}</p>
      </div>
    </ModalFrame>
  )
}

const MCP_SCOPE_LABEL: Record<string, string> = {
  '.mcp.json': '项目 MCP（.mcp.json）',
  project: '项目 MCP（~/.claude.json）',
  user: '用户 MCP（~/.claude.json）'
}

const LIVE_STATE: Record<McpLiveStatus['status'], InventoryState> = {
  connected: 'connected',
  failed: 'failed',
  'needs-auth': 'needs-auth',
  'needs-client-registration': 'required',
  pending: 'pending',
  disabled: 'disabled'
}

const LIVE_TEXT: Record<McpLiveStatus['status'], string> = {
  connected: 'connected',
  failed: 'failed',
  'needs-auth': '需认证',
  'needs-client-registration': '需配置 OAuth Client',
  pending: 'pending',
  disabled: 'disabled'
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
    label: LIVE_TEXT[value.status] + (value.status === 'connected' && value.tools != null ? ' · ' + value.tools + ' tools' : ''),
    detail: value.serverName || value.serverVersion ? [value.serverName, value.serverVersion].filter(Boolean).join(' · ') : '来自当前 Provider 原生运行时'
  }
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
  onToggle,
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
  onToggle: (name: string, enabled: boolean) => void
  onRefresh: () => void
  onClose: () => void
}) {
  const canManage = capability?.mode === 'manage'
  const readsRuntime = capability?.mode === 'read'
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
          <p>配置、Provider 运行态、本次测试与认证是四份独立证据，不折叠成一个模糊的“健康”结论。</p>
        </div>
        <div className="inventory-modal__head-actions">
          {loading && <EvidenceState value={{ state: 'pending', label: loadingConfig ? '读取配置中…' : '正在检测全部 MCP…', role: 'status' }} quiet />}
          <button
            className={'modal-refresh' + (readsRuntime ? ' mcp-refresh-all' : '')}
            onClick={onRefresh}
            disabled={loading || authenticationInProgress}
            title={readsRuntime ? '启动已授权 MCP，并刷新当前 Provider 的全部原生运行状态' : '重新读取当前 Provider 的原生 MCP 配置与运行状态'}
            aria-label={readsRuntime ? '检测全部 MCP 运行状态' : '刷新 MCP 状态'}
          >
            {refreshing && readsRuntime ? <span className="spinner" /> : <Icon name="refresh" />}
            {readsRuntime && <span>{refreshing ? '检测中…' : '检测全部'}</span>}
          </button>
          <button ref={closeRef} className="modal-x" onClick={onClose} aria-label="关闭 MCP"><Icon name="x" /></button>
        </div>
      </div>

      <div className="inventory-fleet-summary" aria-label="MCP 证据摘要">
        <span>{mcps.length} 个配置项</span>
        <span>{live.length > 0 ? connectedCount + ' 已连接 · ' + (live.length - connectedCount) + ' 其他运行态' : 'Provider 运行态未返回'}</span>
        <span>{testEvidenceCount} 个测试证据</span>
      </div>

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
              <caption className="inventory-sr-only">MCP Fleet：配置、运行态、本次测试和认证独立展示</caption>
              <thead>
                <tr>
                  <th scope="col">Server / 来源</th>
                  <th scope="col">配置</th>
                  <th scope="col">Provider 运行态</th>
                  <th scope="col">本次测试</th>
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

                const configValue: EvidenceValue = {
                  state: mcp.enabled ? 'enabled' : 'disabled',
                  label: mcp.enabled ? '已启用' : '已关闭',
                  detail: canManage
                    ? '配置文件中的当前值 · Scry 可管理'
                    : capability?.mode === 'read'
                      ? '配置文件中的当前值 · Scry 只读'
                      : '配置文件中的当前值 · 管理能力未知'
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
                      <td>
                        <div className="mcp-evidence-cell mcp-evidence-cell--config">
                          <span className="mcp-evidence-cell__label">配置</span>
                          <div className="mcp-config-toggle">
                            <InventorySwitch
                              checked={mcp.enabled}
                              disabled={!canManage || authenticationInProgress}
                              label={(mcp.enabled ? '关闭' : '启用') + ' MCP ' + mcp.name}
                              title={configValue.detail}
                              onChange={(enabled) => onToggle(mcp.name, enabled)}
                            />
                            <EvidenceState value={configValue} quiet />
                          </div>
                          <small>{configValue.detail}</small>
                        </div>
                      </td>
                      <td><McpEvidenceCell label="运行态" value={runtimeValue} /></td>
                      <td><McpEvidenceCell label="测试" value={testValue} /></td>
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
                        {needsClientRegistration ? (
                          <small>需在 Provider 中配置 OAuth Client ID</small>
                        ) : needsAuth && !canAuthenticate ? (
                          <small>请在 Provider 客户端完成认证</small>
                        ) : !canManage ? (
                          <small>{readsRuntime ? '运行态只读' : '操作能力未知'}</small>
                        ) : null}
                      </td>
                    </tr>
                    {open && currentStatus?.toolNames && (
                      <tr className="mcp-tools-row">
                        <td colSpan={6}>
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
              ? '当前 Provider 支持由 Scry 管理 MCP 开关与连接测试。'
              : capability?.mode === 'read'
                ? '当前 Provider 只暴露原生 MCP 配置/运行状态，不提供单项直测；使用顶部「检测全部」读取原生运行状态。Scry 不把读取能力伪装成持久化开关。'
                : '当前 Provider 没有可用的 MCP 配置/运行状态接口。'}
        </p>
      </div>
    </ModalFrame>
  )
}
