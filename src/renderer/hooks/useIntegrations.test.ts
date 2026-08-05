import { describe, expect, it, vi } from 'vitest'
import type { CapabilityEnvelope } from '@shared/provider'
import {
  authoritativeRefreshAfterToggle,
  mergeMcpLiveSnapshot,
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
