// 两个弹窗：Skills（列表+开关，软屏蔽）/ MCP（列表+连接测试）。
import { useState } from 'react'
import type { McpStatus } from '../format'
import type { SkillMeta, McpMeta } from '../env'
import type { McpLiveStatus } from '@shared/trace'
import type { CapabilityEnvelope, McpSnapshot } from '@shared/provider'
import { Icon, type IconName } from './primitives/Icon'

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
  const [q, setQ] = useState('')
  const ql = q.trim().toLowerCase()
  const filtered = ql
    ? skills.filter((s) => s.name.toLowerCase().includes(ql) || s.description.toLowerCase().includes(ql))
    : skills
  const groups: Record<string, SkillMeta[]> = {}
  for (const s of filtered) (groups[s.scope] ??= []).push(s)
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Skills</b>{' '}
          <span className="dim">
            {filtered.length}
            {ql ? `/${skills.length}` : ''}
          </span>
          {refreshing && <span className="dim">读取中…</span>}
          {capability && capability.state !== 'ready' && <span className="dim">{capability.reason ?? capability.state}</span>}
          <button className="modal-refresh" onClick={onRefresh} disabled={refreshing} title="重新读取当前 Provider 的 Skill 状态">
            <Icon name="refresh" />
          </button>
          <button className="modal-x" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <input className="modal-search" placeholder="搜索 skill…" value={q} onChange={(e) => setQ(e.target.value)} />
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
                    <label className="switch">
                      <input type="checkbox" checked={s.enabled} disabled={!canManage} onChange={(e) => onToggle(s.name, e.target.checked)} />
                      <span className="slider" />
                    </label>
                    <span className={`skill-name ${s.enabled ? '' : 'off'}`}>{s.name}</span>
                  </div>
                  <div className="skill-desc">{s.description}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-foot dim">
          {canManage ? '当前 Provider 支持由 Scry 管理 Skill 开关。' : '当前 Provider 的 Skill 目录仅供读取；Scry 不修改其私有配置。'}
        </div>
      </div>
    </div>
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
  onTest: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
  onRefresh: () => void
  onClose: () => void
}) {
  const canManage = capability?.mode === 'manage'
  const loadingConfig = configRefreshing && !capability
  const loading = loadingConfig || refreshing
  const [expanded, setExpanded] = useState<string | null>(null)
  const liveByName = new Map(live.map((l) => [l.name, l]))
  const groups: Record<string, McpMeta[]> = {}
  for (const m of mcps) (groups[m.scope] ??= []).push(m)
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>MCP servers</b> <span className="dim">{mcps.length}</span>
          {loading && <span className="dim">{loadingConfig ? '读取配置中…' : '拉取真实状态中…'}</span>}
          {capability && capability.state !== 'ready' && <span className="dim">{capability.reason ?? capability.state}</span>}
          <button
            className="modal-refresh"
            onClick={onRefresh}
            disabled={loading}
            title="重新读取当前 Provider 的原生 MCP 配置与运行状态"
          >
            <Icon name="refresh" />
          </button>
          <button className="modal-x" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          {mcps.length === 0 && <div className="dim pad">{loadingConfig ? '正在读取 MCP 配置…' : '未发现 MCP 配置'}</div>}
          {Object.entries(groups).map(([scope, list]) => (
            <div key={scope}>
              <div className="mcp-scope">{MCP_SCOPE_LABEL[scope] ?? scope}</div>
              {list.map((m) => {
                const st = status[m.name]
                const lv = liveByName.get(m.name)
                const lvLabel = lv ? labelForLiveStatus(lv.status) : undefined
                // 开关跟 SDK 真实态走：有 live 就按它(disabled=关，其余=开)，没 live 退回配置读取
                const enabled = lv ? lv.status !== 'disabled' : m.enabled
                const open = expanded === m.name
                return (
                  <div key={scope + m.name} className="mcp-row">
                    <div className="mcp-main">
                      <label className="switch" title="当前 Provider 支持管理时，可持久化启用或禁用">
                        <input type="checkbox" checked={enabled} disabled={!canManage} onChange={(e) => onToggle(m.name, e.target.checked)} />
                        <span className="slider" />
                      </label>
                      <span className={`mcp-name ${enabled ? '' : 'off'}`}>{m.name}</span>
                      <span className="mcp-transport">{m.transport}</span>
                      {/* live 状态来自 SDK init；pending 是真实的未收敛/待刷新态，不显示成 connected */}
                      {lv && lvLabel ? (
                        <span className={lvLabel.cls} title="来自当前 Provider 原生运行时的真实状态">
                          <Icon name={lvLabel.icon} />
                          {lvLabel.text}
                          {lv.status === 'connected' && st?.tools != null ? ` · ${st.tools} tools` : ''}
                        </span>
                      ) : (
                        <>
                          {st?.testing && <span className="dim">测试中…</span>}
                          {st && !st.testing && st.ok && (
                            <span className="mcp-ok">
                              <Icon name="check" /> connected{st.tools != null ? ` · ${st.tools} tools` : ''}
                            </span>
                          )}
                          {st && !st.testing && !st.ok &&
                            (/40[13]/.test(st.error ?? '') ? (
                              // 裸握手没 OAuth token，401/403 不代表真断——真实状态以 SDK/终端为准（跑一轮即更新）
                              <span className="dim" title="测试握手没带 OAuth token；真实连接以当前 Provider 原生运行时为准">
                                <Icon name="alert" /> 需认证（测试无 token）
                              </span>
                            ) : (
                              <span className="mcp-bad">
                                <Icon name="x" /> {st.error}
                              </span>
                            ))}
                        </>
                      )}
                    </div>
                    <div className="mcp-detail" title={m.detail}>
                      {m.detail}
                    </div>
                    <div className="mcp-actions">
                      <button className="mcp-test" onClick={() => onTest(m.name)} disabled={!canManage || st?.testing}>
                        {st?.testing ? (
                          <>
                            <span className="spinner" /> 测试中…
                          </>
                        ) : (
                          '测试连接'
                        )}
                      </button>
                      {st?.ok && st.toolNames && st.toolNames.length > 0 && (
                        <button className="mcp-test" onClick={() => setExpanded(open ? null : m.name)}>
                          {open ? '收起工具' : `查看工具 (${st.toolNames.length})`}
                        </button>
                      )}
                      <span className="mcp-runtime" title="重新认证与重连由当前 Provider 的原生客户端处理">
                        Re-auth / Reconnect → Provider 客户端
                      </span>
                    </div>
                    {open && st?.toolNames && (
                      <div className="mcp-tools">
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
          {canManage
            ? '当前 Provider 支持由 Scry 管理 MCP 开关与连接测试。'
            : '当前 Provider 只暴露原生 MCP 配置/运行状态；Scry 不把读取能力伪装成持久化开关。'}
        </div>
      </div>
    </div>
  )
}
