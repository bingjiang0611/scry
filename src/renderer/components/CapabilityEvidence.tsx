import { useState } from 'react'

import type { SkillMeta } from '../env'
import type { McpLiveStatus } from '@shared/trace'
import type { CapabilityEnvelope, McpSnapshot } from '@shared/provider'







import './archived-sessions.css'





export type InventoryState = 'enabled' | 'disabled' | 'connected' | 'pending' | 'failed' | 'needs-auth' | 'required' | 'passed' | 'unknown' | 'unsupported'

export interface EvidenceValue {
  state: InventoryState
  label: string
  detail?: string
  role?: 'alert' | 'status'
}

export function EvidenceState({ value, quiet = false }: { value: EvidenceValue; quiet?: boolean }) {
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

export function scopeClass(scope: string): string {
  return scope === 'project' || scope === '.mcp.json' ? 'project' : scope === 'user' ? 'user' : 'unknown'
}

export function scopeShortLabel(scope: string): string {
  return scope === 'project' || scope === '.mcp.json' ? '项目' : scope === 'user' ? '用户' : scope || '未知'
}

export type SkillScopeFilter = 'project' | 'user' | 'provider'

export function skillMatchesScope(skill: SkillMeta, scope: SkillScopeFilter): boolean {
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

export function observedTime(observedAt: number | undefined): string {
  if (!observedAt) return '尚未观测'
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(observedAt)
}

export function InventoryContext({
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

export function useReadStarted(refreshing: boolean): boolean {
  const [started, setStarted] = useState(refreshing)
  if (refreshing && !started) setStarted(true)
  return started || refreshing
}

export const MCP_SCOPE_LABEL: Record<string, string> = {
  '.mcp.json': '项目 MCP（.mcp.json）',
  project: '项目 MCP（~/.claude.json）',
  user: '用户 MCP（~/.claude.json）',
  effective: 'Pi 有效配置（合并后）'
}

export const LIVE_STATE: Record<McpLiveStatus['status'], InventoryState> = {
  connected: 'connected',
  cached: 'unknown',
  disconnected: 'unknown',
  failed: 'failed',
  'needs-auth': 'needs-auth',
  'needs-client-registration': 'required',
  pending: 'pending',
  disabled: 'disabled'
}

export const LIVE_TEXT: Record<McpLiveStatus['status'], string> = {
  connected: '已连接',
  cached: '仅缓存元数据',
  disconnected: '尚未连接',
  failed: '连接失败',
  'needs-auth': '需要认证',
  'needs-client-registration': '需配置 OAuth Client',
  pending: '连接中',
  disabled: '已关闭'
}

export function evidenceForRuntime(value: McpLiveStatus | undefined, capability: CapabilityEnvelope<McpSnapshot> | null | undefined): EvidenceValue {
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
export function shortTestLabel(value: EvidenceValue): string {
  if (value.state === 'passed') return '本次测试通过'
  if (value.state === 'pending') return '测试中…'
  if (value.state === 'needs-auth') return '测试无 OAuth token'
  return value.detail?.replace('本次测试失败 · ', '测试失败 · ') ?? '本次测试失败'
}

export function McpEvidenceCell({ label, value, className = '' }: { label: string; value: EvidenceValue; className?: string }) {
  return (
    <div className={'mcp-evidence-cell' + (className ? ' ' + className : '')}>
      <span className="mcp-evidence-cell__label">{label}</span>
      <EvidenceState value={value} />
      {value.detail && <small>{value.detail}</small>}
    </div>
  )
}
