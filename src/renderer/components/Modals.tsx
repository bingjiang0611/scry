// 全局弹窗：设置 / Skills（列表+开关，软屏蔽）/ MCP（列表+连接测试）。
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { McpStatus } from '../format'
import type { SkillMeta, McpMeta } from '../env'
import type { McpLiveStatus } from '@shared/trace'
import type { CapabilityEnvelope, McpSnapshot } from '@shared/provider'
import { Icon, type IconName } from './primitives/Icon'
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
  const [q, setQ] = useState('')
  const ql = q.trim().toLowerCase()
  const filtered = ql
    ? skills.filter((s) => s.name.toLowerCase().includes(ql) || s.description.toLowerCase().includes(ql))
    : skills
  const groups: Record<string, SkillMeta[]> = {}
  for (const s of filtered) (groups[s.scope] ??= []).push(s)
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={searchRef} className="skills-modal" onClose={onClose}>
        <div className="modal-head">
          <b id={titleId}>Skills</b>{' '}
          <span className="dim">
            {filtered.length}
            {ql ? `/${skills.length}` : ''}
          </span>
          {refreshing && <span className="dim">读取中…</span>}
          {capability && capability.state !== 'ready' && <span className="dim">{capability.reason ?? capability.state}</span>}
          <button className="modal-refresh" onClick={onRefresh} disabled={refreshing} title="重新读取当前 Provider 的 Skill 状态" aria-label="刷新 Skills">
            <Icon name="refresh" />
          </button>
          <button className="modal-x" onClick={onClose} aria-label="关闭 Skills">
            <Icon name="x" />
          </button>
        </div>
        <input ref={searchRef} className="modal-search" placeholder="搜索 skill…" aria-label="搜索 Skills" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="modal-body">
          {filtered.length === 0 && (
            <div className="dim pad">{refreshing && skills.length === 0 ? '正在读取 Skill…' : skills.length === 0 ? '未发现 skill' : '无匹配'}</div>
          )}
          {Object.entries(groups).map(([scope, list]) => (
            <div key={scope}>
              <div className="mcp-scope">{scope === 'project' ? '项目 Skills' : '用户 Skills'}</div>
              {list.map((s) => (
                <div key={s.name} className="skill-row">
                  <div className="skill-tog">
                    <span className={`skill-name ${s.enabled ? '' : 'off'}`}>{s.name}</span>
                    <label className="switch skill-switch">
                      <input type="checkbox" aria-label={`启用 Skill ${s.name}`} checked={s.enabled} disabled={!canManage} onChange={(e) => onToggle(s.name, e.target.checked)} />
                      <span className="slider" aria-hidden="true" />
                      <span className="skill-switch-state" aria-hidden="true">{s.enabled ? '已启用' : '已关闭'}</span>
                    </label>
                  </div>
                  <div className="skill-desc" title={s.description}>{s.description}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-foot dim">
          {canManage ? '当前 Provider 支持由 Scry 管理 Skill 开关。' : '当前 Provider 的 Skill 目录仅供读取；Scry 不修改其私有配置。'}
        </div>
    </ModalFrame>
  )
}

const MCP_SCOPE_LABEL: Record<string, string> = {
  '.mcp.json': '项目 MCP（.mcp.json）',
  project: '项目 MCP（~/.claude.json）',
  user: '用户 MCP（~/.claude.json）'
}

const LIVE_LABEL: Record<McpLiveStatus['status'], { cls: string; text: string; icon: IconName }> = {
  connected: { cls: 'mcp-ok', text: 'connected', icon: 'check' },
  failed: { cls: 'mcp-bad', text: 'failed', icon: 'x' },
  'needs-auth': { cls: 'mcp-bad', text: '需认证', icon: 'alert' },
  'needs-client-registration': { cls: 'mcp-bad', text: '需配置 OAuth Client', icon: 'alert' },
  pending: { cls: 'mcp-neutral', text: 'pending', icon: 'clock' },
  disabled: { cls: 'mcp-neutral', text: 'disabled', icon: 'square' }
}

function labelForLiveStatus(status: string): { cls: string; text: string; icon: IconName } {
  return LIVE_LABEL[status as McpLiveStatus['status']] ?? { cls: 'mcp-neutral', text: status || 'unknown', icon: 'alert' }
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
  const liveByName = new Map(live.map((l) => [l.name, l]))
  const groups: Record<string, McpMeta[]> = {}
  for (const m of mcps) (groups[m.scope] ??= []).push(m)
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={closeRef} onClose={onClose}>
        <div className="modal-head">
          <b id={titleId}>MCP servers</b> <span className="dim">{mcps.length}</span>
          {loading && <span className="dim" role="status" aria-live="polite">{loadingConfig ? '读取配置中…' : '正在检测全部 MCP…'}</span>}
          {capability && capability.state !== 'ready' && (
            <span className="dim" role={capability.state === 'unknown' ? 'alert' : 'status'}>
              {capability.reason ?? capability.state}
            </span>
          )}
          <button
            className={`modal-refresh${readsRuntime ? ' mcp-refresh-all' : ''}`}
            onClick={onRefresh}
            disabled={loading || authenticationInProgress}
            title={readsRuntime
              ? '启动已授权 MCP，并刷新当前 Provider 的全部原生运行状态'
              : '重新读取当前 Provider 的原生 MCP 配置与运行状态'}
            aria-label={readsRuntime ? '检测全部 MCP 运行状态' : '刷新 MCP 状态'}
          >
            {refreshing && readsRuntime ? <span className="spinner" /> : <Icon name="refresh" />}
            {readsRuntime && <span>{refreshing ? '检测中…' : '检测全部'}</span>}
          </button>
          <button ref={closeRef} className="modal-x" onClick={onClose} aria-label="关闭 MCP">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          {mcps.length === 0 && <div className="dim pad">{loadingConfig ? '正在读取 MCP 配置…' : '未发现 MCP 配置'}</div>}
          {Object.entries(groups).map(([scope, list]) => (
            <div key={scope}>
              <div className="mcp-scope">{MCP_SCOPE_LABEL[scope] ?? scope}</div>
              {list.map((m, index) => {
                const targetId = m.targetId ?? m.name
                const st = status[targetId]
                const lv = liveByName.get(m.name)
                const lvLabel = lv ? labelForLiveStatus(lv.status) : undefined
                // 开关跟 SDK 真实态走：有 live 就按它(disabled=关，其余=开)，没 live 退回配置读取
                const enabled = lv ? lv.status !== 'disabled' : m.enabled
                const open = expanded === targetId
                const toolsId = `${titleId}-tools-${scope}-${index}`
                const authLimited = st && !st.testing && !st.ok && /40[13]/.test(st.error ?? '')
                const canAuthenticate = Boolean(
                  onReauthenticate && capability?.data?.operations?.authenticate.includes(targetId)
                )
                const needsAuth = lv?.status === 'needs-auth'
                const needsClientRegistration = lv?.status === 'needs-client-registration'
                return (
                  <div key={scope + m.name} className="mcp-row">
                    <div className="mcp-main">
                      <label className="switch" title="当前 Provider 支持管理时，可持久化启用或禁用">
                        <input type="checkbox" aria-label={`启用 MCP ${m.name}`} checked={enabled} disabled={!canManage || authenticationInProgress} onChange={(e) => onToggle(m.name, e.target.checked)} />
                        <span className="slider" />
                      </label>
                      <span className={`mcp-name ${enabled ? '' : 'off'}`}>{m.name}</span>
                      <span className="mcp-transport">{m.transport}</span>
                      {/* live 状态来自 SDK init；pending 是真实的未收敛/待刷新态，不显示成 connected */}
                      {lv && lvLabel && (
                        <span className={lvLabel.cls} title="来自当前 Provider 原生运行时的真实状态">
                          <Icon name={lvLabel.icon} />
                          {lvLabel.text}
                          {lv.status === 'connected' && lv.tools != null ? ` · ${lv.tools} tools` : ''}
                        </span>
                      )}
                    </div>
                    <div className="mcp-detail" title={m.detail}>
                      {m.detail}
                    </div>
                    <div className="mcp-actions">
                      {canManage && (
                        <button className="mcp-test" onClick={() => onTest(targetId)} disabled={st?.testing || authenticationInProgress}>
                          {st?.testing ? (
                            <>
                              <span className="spinner" /> 测试中…
                            </>
                          ) : (
                            '测试连接'
                          )}
                        </button>
                      )}
                      {canManage && st && (
                        <span
                          className={`mcp-test-result ${st.testing ? '' : st.ok ? 'ok' : authLimited ? 'warn' : 'bad'}`}
                          role={!st.testing && !st.ok ? 'alert' : 'status'}
                          aria-live="polite"
                          title={authLimited ? '测试握手没带 OAuth token；真实连接以当前 Provider 原生运行时为准' : undefined}
                        >
                          {st.testing
                            ? '正在执行 initialize / tools/list…'
                            : st.ok
                              ? `本次测试成功${st.tools != null ? ` · ${st.tools} tools` : ''}`
                              : authLimited
                                ? '需认证（测试无 token）'
                                : `本次测试失败${st.error ? ` · ${st.error}` : ''}`}
                        </span>
                      )}
                      {st?.ok && st.toolNames && st.toolNames.length > 0 && (
                        <button
                          className="mcp-test"
                          aria-expanded={open}
                          aria-controls={toolsId}
                          onClick={() => setExpanded(open ? null : targetId)}
                        >
                          {open ? '收起工具' : `查看工具 (${st.toolNames.length})`}
                        </button>
                      )}
                      {needsAuth && canAuthenticate && (
                        <button
                          className="mcp-test"
                          onClick={() => onReauthenticate?.(targetId)}
                          disabled={authenticationInProgress}
                          aria-label={`重新认证 MCP ${m.name}`}
                        >
                          {st?.authenticating ? (
                            <><span className="spinner" /> 认证中…</>
                          ) : '重新认证'}
                        </button>
                      )}
                      {(st?.authenticating || st?.authOk != null || st?.authError) && (
                        <span
                          className={`mcp-test-result ${st.authenticating ? '' : st.authOk ? st.authError ? 'warn' : 'ok' : 'bad'}`}
                          role={!st.authenticating && !st.authOk ? 'alert' : 'status'}
                          aria-live="polite"
                        >
                          {st.authenticating
                            ? '等待浏览器完成授权…'
                            : st.authOk
                              ? st.authError
                                ? `授权流程已完成；运行状态未确认 · ${st.authError}`
                                : '认证成功，运行状态已刷新'
                              : `认证失败${st.authError ? ` · ${st.authError}` : ''}`}
                        </span>
                      )}
                      {needsClientRegistration ? (
                        <span className="mcp-runtime">需在 Provider 中配置 OAuth Client ID</span>
                      ) : needsAuth && !canAuthenticate ? (
                        <span className="mcp-runtime">请在 Provider 客户端完成认证</span>
                      ) : null}
                    </div>
                    {open && st?.toolNames && (
                      <div id={toolsId} className="mcp-tools">
                        {st.toolNames.map((t) => (
                          <span key={t} className="mcp-tool">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="modal-foot dim">
          {capability?.data?.operations?.authenticate.length
            ? '支持认证的远程 MCP 可直接在 Scry 完成 Provider 原生 OAuth；凭据由 Provider 保存在本机（OpenCode 使用 Scry 私有目录），不会上传。'
            : canManage
            ? '当前 Provider 支持由 Scry 管理 MCP 开关与连接测试。'
            : capability?.mode === 'read'
              ? '当前 Provider 只暴露原生 MCP 配置/运行状态，不提供单项直测；使用顶部「检测全部」读取原生运行状态。Scry 不把读取能力伪装成持久化开关。'
              : '当前 Provider 没有可用的 MCP 配置/运行状态接口。'}
        </div>
    </ModalFrame>
  )
}
