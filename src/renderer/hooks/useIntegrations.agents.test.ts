import { describe, expect, it, vi } from 'vitest'
import type { CapabilityEnvelope } from '@shared/provider'
import type { AgentRunControlCatalog } from '@shared/runtime'
import { reconcileSelectedAgentId, requestRunControlsForSelectedProvider, resolveRunControlSelection, runControlSendBlockedReason } from './useIntegrations'

describe('Agent 切换时的运行控制门禁', () => {
  it('探测结果优先保留当前选择，缺失时回退首个可用 Agent', () => {
    const detected = [
      { id: 'claude', name: 'Claude Code', path: '/usr/local/bin/claude', bin: 'claude' },
      { id: 'codex', name: 'Codex', path: '/usr/local/bin/codex', bin: 'codex' }
    ]

    expect(reconcileSelectedAgentId('qoder', detected)).toBe('claude')
    expect(reconcileSelectedAgentId('codex', detected)).toBe('codex')
    expect(reconcileSelectedAgentId('qoder', [])).toBe('qoder')
  })

  it('Pi 当前 Profile 不可用时自动切到同 Provider 的可用 Profile', () => {
    const detected = [{
      id: 'pi:default',
      name: 'Pi',
      path: '/Users/example/.local/bin/pi',
      bin: 'pi',
      health: { state: 'unavailable' as const, transport: 'CLI version probe', lastError: '版本探测退出码 1' }
    }, {
      id: 'pi:25f2d533d0a8b391',
      name: 'Pi · pi-agent',
      path: '/Users/example/dev-agent/pi-agent/bin/pi-agent',
      bin: 'pi-agent',
      health: { state: 'ready' as const, transport: 'JSONL RPC subprocess' }
    }, {
      id: 'codex',
      name: 'Codex',
      path: '/usr/local/bin/codex',
      bin: 'codex',
      health: { state: 'ready' as const, transport: 'app-server' }
    }]

    expect(reconcileSelectedAgentId('pi:default', detected)).toBe('pi:25f2d533d0a8b391')
    expect(reconcileSelectedAgentId('pi:missing', detected)).toBe('pi:25f2d533d0a8b391')
    // 只有一个 Profile 的 Provider 不可用时保持用户选择，不跨 Provider 静默切换。
    expect(reconcileSelectedAgentId('claude', [{
      id: 'claude',
      name: 'Claude Code',
      path: '/usr/local/bin/claude',
      bin: 'claude',
      health: { state: 'unavailable', transport: 'Agent SDK' }
    }, ...detected])).toBe('claude')
  })

  it('Claude 选中时只请求 Claude 的运行控制，不预热 Codex', async () => {
    const request = vi.fn().mockResolvedValue(null)

    await requestRunControlsForSelectedProvider('claude', '/repo', request)

    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith({ providerId: 'claude', cwd: '/repo' })
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ providerId: 'codex' }))
  })

  it.each(['claude', 'codex', 'qoder', 'opencode'] as const)('%s 目录读取期间仅允许默认模型和默认审批立即发送', (providerId) => {
    expect(runControlSendBlockedReason(providerId, null, true, { permissionMode: 'default' })).toBeNull()
    expect(runControlSendBlockedReason(providerId, null, true, {
      permissionMode: 'full_access'
    })).toBe('运行权限能力尚未确认，暂不能发送')
    expect(runControlSendBlockedReason(providerId, null, true, {
      model: { id: 'ultimate' },
      permissionMode: 'default'
    })).toBe('运行权限能力尚未确认，暂不能发送')
  })

  it.each(['default', 'full_access'] as const)('Pi 目录读取期间不以 %s 权限抢先发送', (permissionMode) => {
    expect(runControlSendBlockedReason('pi', null, true, { permissionMode })).toBe(
      '运行权限能力尚未确认，暂不能发送'
    )
  })

  it('探测完成后的 unknown/unsupported 仍然 fail closed', () => {
    expect(runControlSendBlockedReason('qoder', {
      providerId: 'qoder',
      mode: 'none',
      state: 'unknown',
      data: null,
      reason: 'Qoder 控制接口不可用'
    }, false, { permissionMode: 'default' })).toBe('Qoder 控制接口不可用')
  })

  it('恢复仍有效的权限，且多选项存在默认审批时不升级权限', () => {
    const catalog: AgentRunControlCatalog = {
      models: [], permissions: [{ id: 'default', label: 'Default', description: 'Native approvals' }, { id: 'full_access', label: 'Full access', description: 'Host user permissions' }]
    }
    expect(resolveRunControlSelection(catalog, { permissionMode: 'full_access' }).permissionMode).toBe('full_access')
    expect(resolveRunControlSelection(catalog, { permissionMode: 'auto_review' }).permissionMode).toBe('default')
  })

  it('按唯一可用权限初始化 Pi，且不改写主机权限语义', () => {
    const catalog: AgentRunControlCatalog = {
      models: [{ model: { id: 'pi-model' }, label: 'Pi', efforts: [] }],
      permissions: [{ id: 'full_access', label: '本机完全访问', description: '继承本机用户权限' }]
    }
    const controls = resolveRunControlSelection(catalog, { permissionMode: 'default' })
    const capability: CapabilityEnvelope<AgentRunControlCatalog> = {
      providerId: 'pi', mode: 'read', state: 'ready', data: catalog
    }

    expect(controls.permissionMode).toBe('full_access')
    expect(runControlSendBlockedReason('pi', capability, false, controls)).toBeNull()
    expect(runControlSendBlockedReason('pi', capability, false, { permissionMode: 'full_access' })).toBeNull()
  })
})
