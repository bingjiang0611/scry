import { describe, expect, it, vi } from 'vitest'
import type { CapabilityEnvelope } from '@shared/provider'
import type { AgentRunControlCatalog } from '@shared/runtime'
import {
  authoritativeRefreshAfterToggle,
  capabilityMatchesContext,
  isAuthoritativeRunControlCatalog,
  mergeMcpLiveSnapshot,
  mcpAuthVerificationError,
  parseRunControlCatalogCache,
  parseRunControlPreferences,
  reconcileMcpAuthStatus,
  retainCachedRunControlCatalog,
  requestRunControlsForSelectedProvider,
  runControlSendBlockedReason,
  serializeRunControlCatalogCache,
  shouldKeepCachedRunControlCatalog
} from './useIntegrations'

const result = (data: boolean | null, state: CapabilityEnvelope<boolean>['state'] = 'ready'): CapabilityEnvelope<boolean> => ({
  providerId: 'claude',
  mode: data === null ? 'none' : 'manage',
  state,
  data
})

describe('Skill/MCP 操作后的权威状态同步', () => {
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
  it('Claude 选中时只请求 Claude 的运行控制，不预热 Codex', async () => {
    const request = vi.fn().mockResolvedValue(null)

    await requestRunControlsForSelectedProvider('claude', '/repo', request)

    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith({ providerId: 'claude', cwd: '/repo' })
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ providerId: 'codex' }))
  })

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

describe('模型目录跨进程缓存', () => {
  const now = 1_800_000_000_000
  const catalog = (id: string): AgentRunControlCatalog => ({
    models: [{ model: { id }, label: id.toUpperCase(), efforts: [{ id: 'high', label: 'High', isDefault: true }] }],
    permissions: [{ id: 'default', label: '默认审批', description: '危险操作会暂停并请求你的确认' }]
  })
  const envelope = (
    providerId: CapabilityEnvelope<AgentRunControlCatalog>['providerId'],
    cwd: string | undefined,
    data: AgentRunControlCatalog,
    observedAt: number
  ): CapabilityEnvelope<AgentRunControlCatalog> => ({
    providerId,
    ...(cwd ? { cwd } : {}),
    mode: 'read',
    state: 'ready',
    data,
    observedAt
  })

  it('按 Provider + cwd 隔离恢复上次读到的目录，不把一个 Provider 的模型串到另一个', () => {
    const stored = serializeRunControlCatalogCache(new Map([
      ['qoder\u0000/repo', envelope('qoder', '/repo', catalog('ultimate'), now - 1_000)],
      ['codex\u0000/repo', envelope('codex', '/repo', catalog('gpt-5.4'), now - 2_000)]
    ]))

    const restored = parseRunControlCatalogCache(stored, now)

    expect(restored.get('qoder\u0000/repo')?.data?.models.map((model) => model.model.id)).toEqual(['ultimate'])
    expect(restored.get('codex\u0000/repo')?.data?.models.map((model) => model.model.id)).toEqual(['gpt-5.4'])
    expect(restored.get('qoder\u0000/other')).toBeUndefined()
    expect(restored.get('claude\u0000/repo')).toBeUndefined()
    expect(restored.get('qoder\u0000/repo')?.data?.models[0].efforts).toEqual([
      { id: 'high', label: 'High', isDefault: true }
    ])
  })

  it('丢弃损坏、过期或未来时间戳的条目，不恢复空目录', () => {
    expect(parseRunControlCatalogCache('{broken', now).size).toBe(0)
    expect(parseRunControlCatalogCache(JSON.stringify({
      entries: [
        { providerId: 'qoder', cwd: '/repo', observedAt: now - 8 * 24 * 60 * 60 * 1000, ...catalog('stale') },
        { providerId: 'qoder', cwd: '/future', observedAt: now + 60_000, ...catalog('future') },
        { providerId: 'nope', cwd: '/repo', observedAt: now, ...catalog('unknown-provider') },
        { providerId: 'qoder', cwd: '/empty', observedAt: now, models: [], permissions: [] },
        { providerId: 'qoder', cwd: '/partial', observedAt: now, models: [{ label: '缺少 model' }], permissions: [] }
      ]
    }), now).size).toBe(0)
  })

  it('保留超过偏好字段限制的合法 cwd，不误归到未绑定上下文', () => {
    const cwd = `/${'nested/'.repeat(40)}repo`
    const restored = parseRunControlCatalogCache(JSON.stringify({
      entries: [{ providerId: 'qoder', cwd, observedAt: now, ...catalog('ultimate') }]
    }), now)

    expect(cwd.length).toBeGreaterThan(240)
    expect(restored.get(`qoder\u0000${cwd}`)?.data?.models[0].model.id).toBe('ultimate')
    expect(restored.get('qoder\u0000')).toBeUndefined()
  })

  it('恢复的目录标注来源与读取时间，且在本次探测确认前仍拒绝发送', () => {
    const restored = parseRunControlCatalogCache(
      serializeRunControlCatalogCache(new Map([
        ['qoder\u0000/repo', envelope('qoder', '/repo', catalog('ultimate'), now - 1_000)]
      ])),
      now
    ).get('qoder\u0000/repo')!

    expect(restored.state).toBe('unknown')
    expect(restored.reason).toContain('最后已知模型目录')
    expect(runControlSendBlockedReason(restored, false, { permissionMode: 'default' })).toBeNull()
    expect(runControlSendBlockedReason(restored, false, { model: { id: 'ultimate' }, permissionMode: 'default' }))
      .toBe(restored.reason)
    expect(runControlSendBlockedReason(
      envelope('qoder', '/repo', catalog('ultimate'), now),
      false,
      { model: { id: 'ultimate' }, permissionMode: 'default' }
    )).toBeNull()
  })

  it('非权威刷新结果不覆盖已知目录，权威结果才替换', () => {
    const known = catalog('ultimate')
    const timedOut: CapabilityEnvelope<AgentRunControlCatalog> = {
      providerId: 'qoder',
      cwd: '/repo',
      mode: 'read',
      state: 'degraded',
      data: { models: [], permissions: catalog('ultimate').permissions },
      reason: 'Qoder 控制会话 20 秒内未完成初始化'
    }

    expect(isAuthoritativeRunControlCatalog(timedOut)).toBe(false)
    expect(shouldKeepCachedRunControlCatalog(known, timedOut)).toBe(true)
    expect(shouldKeepCachedRunControlCatalog(undefined, timedOut)).toBe(false)
    expect(shouldKeepCachedRunControlCatalog(known, envelope('qoder', '/repo', catalog('performance'), now))).toBe(false)
    expect(isAuthoritativeRunControlCatalog({ ...timedOut, data: catalog('performance') })).toBe(true)
    expect(isAuthoritativeRunControlCatalog({
      ...timedOut,
      state: 'unknown',
      data: catalog('performance')
    })).toBe(false)

    const retained = retainCachedRunControlCatalog(
      envelope('qoder', '/repo', known, now - 1_000),
      timedOut
    )
    expect(retained).toMatchObject({
      state: 'unknown',
      data: known,
      reason: expect.stringContaining('当前显示最后已知模型目录')
    })
    expect(runControlSendBlockedReason(retained, false, { permissionMode: 'default' })).toBeNull()
    expect(runControlSendBlockedReason(retained, false, {
      model: { id: 'ultimate' },
      permissionMode: 'default'
    })).toBe(retained.reason)
  })
})
