import { describe, expect, it, vi } from 'vitest'
import type { CapabilityEnvelope } from '@shared/provider'
import {
  authoritativeRefreshAfterToggle,
  mergeMcpLiveSnapshot,
  mcpAuthVerificationError,
  parseRunControlPreferences,
  reconcileMcpAuthStatus,
  runControlSendBlockedReason
} from './useIntegrations'

const result = (data: boolean | null, state: CapabilityEnvelope<boolean>['state'] = 'ready'): CapabilityEnvelope<boolean> => ({
  providerId: 'claude',
  mode: data === null ? 'none' : 'manage',
  state,
  data
})

describe('Skill/MCP 操作后的权威状态同步', () => {
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

describe('Agent 切换时的运行控制门禁', () => {
  it('目录读取期间仅允许 Provider 默认模型和默认审批立即发送', () => {
    expect(runControlSendBlockedReason(null, true, { permissionMode: 'default' })).toBeNull()
    expect(runControlSendBlockedReason(null, true, {
      permissionMode: 'full_access'
    })).toBe('运行权限能力尚未确认，暂不能发送')
    expect(runControlSendBlockedReason(null, true, {
      model: { id: 'ultimate' },
      permissionMode: 'default'
    })).toBe('运行权限能力尚未确认，暂不能发送')
  })

  it('探测完成后的 unknown/unsupported 仍然 fail closed', () => {
    expect(runControlSendBlockedReason({
      providerId: 'qoder',
      mode: 'none',
      state: 'unknown',
      data: null,
      reason: 'Qoder 控制接口不可用'
    }, false, { permissionMode: 'default' })).toBe('Qoder 控制接口不可用')
  })
})

describe('运行控制偏好恢复', () => {
  it('恢复最后 Agent 及各 Provider 的模型、effort 和权限', () => {
    expect(parseRunControlPreferences(JSON.stringify({
      selectedAgentId: 'qoder',
      controlsByProvider: {
        qoder: {
          model: { id: 'ultimate' },
          effort: 'high',
          permissionMode: 'full_access'
        },
        codex: {
          model: { id: 'gpt-5.4', providerId: 'openai' },
          effort: 'medium',
          permissionMode: 'auto_review'
        }
      }
    }))).toEqual({
      selectedAgentId: 'qoder',
      controlsByProvider: {
        qoder: {
          model: { id: 'ultimate' },
          effort: 'high',
          permissionMode: 'full_access'
        },
        codex: {
          model: { id: 'gpt-5.4', providerId: 'openai' },
          effort: 'medium',
          permissionMode: 'auto_review'
        }
      }
    })
  })

  it('损坏或越界偏好回退默认审批，不恢复未知 Agent/Provider', () => {
    expect(parseRunControlPreferences('{broken')).toEqual({
      selectedAgentId: 'claude',
      controlsByProvider: {}
    })
    expect(parseRunControlPreferences(JSON.stringify({
      selectedAgentId: 'unknown-agent',
      controlsByProvider: {
        qoder: { model: { id: 42 }, effort: '', permissionMode: 'root' },
        unknown: { permissionMode: 'full_access' }
      }
    }))).toEqual({
      selectedAgentId: 'claude',
      controlsByProvider: {
        qoder: { permissionMode: 'default' }
      }
    })
  })
})
