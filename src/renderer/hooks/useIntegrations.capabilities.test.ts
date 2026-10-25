import { describe, expect, it, vi } from 'vitest'
import type { CapabilityEnvelope } from '@shared/provider'
import {
  applyDataUpdatedEffects,
  authoritativeRefreshAfterToggle,
  capabilityMatchesContext,
  capabilityRows,
  mergeMcpLiveSnapshot,
  mcpAuthVerificationError,
  reconcileMcpAuthStatus
} from './useIntegrations'

const result = (data: boolean | null, state: CapabilityEnvelope<boolean>['state'] = 'ready'): CapabilityEnvelope<boolean> => ({
  providerId: 'claude',
  mode: data === null ? 'none' : 'manage',
  state,
  data
})

describe('Skill/MCP 操作后的权威状态同步', () => {
  it('SQLite 持久化完成后只刷新已经打开过的范围分析', () => {
    const loadStats = vi.fn()
    const loadBillingState = vi.fn()
    const loadAnalytics = vi.fn()

    applyDataUpdatedEffects({ loadStats, loadBillingState, loadAnalytics, analyticsActive: false })

    expect(loadStats).toHaveBeenCalledOnce()
    expect(loadBillingState).toHaveBeenCalledOnce()
    expect(loadAnalytics).not.toHaveBeenCalled()

    applyDataUpdatedEffects({ loadStats, loadBillingState, loadAnalytics, analyticsActive: true })
    expect(loadAnalytics).toHaveBeenCalledOnce()
  })

  it('Provider 或 cwd 改变后不暴露旧上下文的能力证据', () => {
    const capability: CapabilityEnvelope<boolean> = {
      providerId: 'qoder',
      cwd: '/repo-a',
      mode: 'read',
      state: 'ready',
      data: true
    }

    expect(capabilityMatchesContext(capability, { providerId: 'qoder', cwd: '/repo-a' })).toBe(true)
    expect(capabilityMatchesContext(capability, { providerId: 'qoder', cwd: '/repo-b' })).toBe(false)
    expect(capabilityMatchesContext(capability, { providerId: 'codex', cwd: '/repo-a' })).toBe(false)
  })

  it('权威能力回读无数据时清空旧列表，而不是继续展示陈旧 Skill', () => {
    const unavailable: CapabilityEnvelope<string[]> = {
      providerId: 'qoder',
      cwd: '/repo',
      mode: 'read',
      state: 'unknown',
      data: null,
      reason: 'catalog unavailable'
    }
    const empty: CapabilityEnvelope<string[]> = { ...unavailable, state: 'ready', data: [] }

    expect(capabilityRows(unavailable)).toEqual([])
    expect(capabilityRows(empty)).toEqual([])
  })

  it('操作成功后执行一次 provider 回读并返回权威快照', async () => {
    const refresh = vi.fn().mockResolvedValue({ enabled: false })

    await expect(authoritativeRefreshAfterToggle(result(true), refresh)).resolves.toEqual({ enabled: false })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('unsupported 或失败操作不触发伪回读', async () => {
    const refresh = vi.fn()

    await expect(authoritativeRefreshAfterToggle(result(null, 'unsupported'), refresh)).resolves.toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('MCP runtime 未知时保留已有 live 缓存，明确空数组时才清空', () => {
    const cached = [{ name: 'github', status: 'connected' as const }]

    expect(mergeMcpLiveSnapshot(cached, null)).toBe(cached)
    expect(mergeMcpLiveSnapshot(cached, undefined)).toBe(cached)
    expect(mergeMcpLiveSnapshot(cached, [])).toEqual([])
    expect(mergeMcpLiveSnapshot(cached, null, true)).toEqual([])
  })

  it('仅在权威运行态确认连接后清理过时认证结果', () => {
    const current = {
      connected: { ok: false, authOk: false, authError: '旧错误' },
      required: { ok: false, authOk: false, authError: '仍失败' },
      failed: { ok: false, authOk: false, authError: '校验失败' },
      pending: { ok: false, authOk: true, authError: '已认证，等待连接' },
      active: { ok: false, authenticating: true, authError: '等待中' },
      removed: { ok: false, authOk: true }
    }
    const configured = [
      { targetId: 'connected', name: 'connected', scope: 'user', transport: 'http', detail: '', enabled: true },
      { targetId: 'required', name: 'required', scope: 'user', transport: 'http', detail: '', enabled: true },
      { targetId: 'failed', name: 'failed', scope: 'user', transport: 'http', detail: '', enabled: true },
      { targetId: 'pending', name: 'pending', scope: 'user', transport: 'http', detail: '', enabled: true },
      { targetId: 'active', name: 'active', scope: 'user', transport: 'http', detail: '', enabled: true }
    ]
    expect(reconcileMcpAuthStatus(current, configured, [
      { name: 'connected', status: 'connected' },
      { name: 'required', status: 'needs-auth' },
      { name: 'failed', status: 'failed' },
      { name: 'pending', status: 'pending' },
      { name: 'active', status: 'connected' }
    ])).toEqual({
      connected: { ok: false },
      required: current.required,
      failed: current.failed,
      pending: current.pending,
      active: current.active
    })
  })

  it('按精确 targetId 判定认证后连接是否收敛', () => {
    const base = {
      configured: [
        { targetId: 'first-target', name: 'shared', scope: 'user', transport: 'http', detail: '', enabled: true },
        { targetId: 'second-target', name: 'other', scope: 'project', transport: 'http', detail: '', enabled: true }
      ],
      runtime: [
        { name: 'shared', status: 'connected' as const },
        { name: 'other', status: 'needs-auth' as const }
      ]
    }
    expect(mcpAuthVerificationError(base, 'first-target')).toBeUndefined()
    expect(mcpAuthVerificationError(base, 'second-target')).toBe('刷新后运行状态为 needs-auth')
    expect(mcpAuthVerificationError({ ...base, runtime: null }, 'first-target')).toBe('刷新后运行状态为 未返回')
  })
})
