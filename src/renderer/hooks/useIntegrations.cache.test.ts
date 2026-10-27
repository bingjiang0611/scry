import { describe, expect, it } from 'vitest'
import type { CapabilityEnvelope } from '@shared/provider'
import type { AgentRunControlCatalog } from '@shared/runtime'
import {
  isAuthoritativeRunControlCatalog,
  lastKnownRunControlCatalog,
  parseRunControlCatalogCache,
  resolveRunControlDisplay,
  retainCachedRunControlCatalog,
  runControlSendBlockedReason,
  serializeRunControlCatalogCache,
  shouldKeepCachedRunControlCatalog
} from './useIntegrations'

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

    expect(restored.get('qoder\u0000\u0000/repo')?.data?.models.map((model) => model.model.id)).toEqual(['ultimate'])
    expect(restored.get('codex\u0000\u0000/repo')?.data?.models.map((model) => model.model.id)).toEqual(['gpt-5.4'])
    expect(restored.get('qoder\u0000\u0000/other')).toBeUndefined()
    expect(restored.get('claude\u0000\u0000/repo')).toBeUndefined()
    expect(restored.get('qoder\u0000\u0000/repo')?.data?.models[0].efforts).toEqual([
      { id: 'high', label: 'High', isDefault: true }
    ])
  })

  it('同一 Pi Provider 的不同 Agent Profile 使用独立模型目录', () => {
    const nativePi = {
      ...envelope('pi', '/repo', catalog('native-model'), now - 1_000),
      agentProfileId: 'pi:default'
    }
    const devAgent = {
      ...envelope('pi', '/repo', catalog('dev-model'), now - 2_000),
      agentProfileId: 'pi:0123456789abcdef'
    }
    const restored = parseRunControlCatalogCache(serializeRunControlCatalogCache(new Map([
      ['native', nativePi],
      ['custom', devAgent]
    ])), now)

    expect(restored.get('pi\u0000pi:default\u0000/repo')?.data?.models[0].model.id).toBe('native-model')
    expect(restored.get('pi\u0000pi:0123456789abcdef\u0000/repo')?.data?.models[0].model.id).toBe('dev-model')
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
    expect(restored.get(`qoder\u0000\u0000${cwd}`)?.data?.models[0].model.id).toBe('ultimate')
    expect(restored.get('qoder\u0000\u0000')).toBeUndefined()
  })

  it('恢复的目录标注来源与读取时间，并允许使用缓存中可精确证明的选项', () => {
    const restored = parseRunControlCatalogCache(
      serializeRunControlCatalogCache(new Map([
        ['qoder\u0000/repo', envelope('qoder', '/repo', catalog('ultimate'), now - 1_000)]
      ])),
      now
    ).get('qoder\u0000\u0000/repo')!

    expect(restored.state).toBe('unknown')
    expect(restored.reason).toContain('最后已知模型目录')
    expect(runControlSendBlockedReason('qoder', restored, false, { permissionMode: 'default' })).toBeNull()
    expect(runControlSendBlockedReason('qoder', restored, false, {
      model: { id: 'ultimate' },
      effort: 'high',
      permissionMode: 'default'
    })).toBeNull()
    expect(runControlSendBlockedReason('qoder', restored, false, {
      model: { id: 'not-in-cache' },
      permissionMode: 'default'
    })).toBe('最后已知模型目录不包含当前模型、推理强度或权限，请重新选择')
    expect(runControlSendBlockedReason(
      'qoder',
      envelope('qoder', '/repo', catalog('ultimate'), now),
      false,
      { model: { id: 'ultimate' }, permissionMode: 'default' }
    )).toBeNull()
  })

  it('切换会话时不把 Pi 的发送界面退回占位权限', () => {
    const piCatalog: AgentRunControlCatalog = {
      models: [{ model: { id: 'claude-sonnet-4', providerId: 'anthropic' }, label: 'Sonnet', efforts: [] }],
      permissions: [{ id: 'full_access', label: '本机完全访问', description: 'Pi 没有内置沙箱' }]
    }
    const catalogFor = (cwd: string, observedAt: number, agentProfileId = 'pi:default') => ({
      providerId: 'pi' as const,
      agentProfileId,
      cwd,
      mode: 'read' as const,
      state: 'ready' as const,
      data: piCatalog,
      observedAt
    })
    const catalogs = new Map([
      ['pi\u0000pi:default\u0000/older', catalogFor('/older', now - 9_000)],
      ['pi\u0000pi:default\u0000/repo', catalogFor('/repo', now - 1_000)],
      ['pi\u0000pi:0123456789abcdef\u0000/repo', catalogFor('/repo', now, 'pi:0123456789abcdef')]
    ])

    const seeded = lastKnownRunControlCatalog(catalogs, {
      providerId: 'pi', agentProfileId: 'pi:default', cwd: '/another-session'
    })

    // 目录内容与 cwd 无关时才复用；来源时间与正在复核仍然显式存在。
    expect(seeded?.state).toBe('unknown')
    expect(seeded?.cwd).toBe('/repo')
    expect(seeded?.data).toBe(piCatalog)
    expect(seeded?.reason).toContain('最后已知模型目录')
    expect(runControlSendBlockedReason('pi', seeded!, false, { permissionMode: 'full_access' })).toBeNull()
    // 没有最后已知目录时仍然 fail closed，不用占位权限抢发。
    expect(runControlSendBlockedReason('pi', null, true, { permissionMode: 'full_access' })).toBe(
      '运行权限能力尚未确认，暂不能发送'
    )
    expect(lastKnownRunControlCatalog(catalogs, {
      providerId: 'pi', agentProfileId: 'pi:missing', cwd: '/repo'
    })).toBeUndefined()
    // 目录可能按 cwd 返回模型（例如 OpenCode 按 directory 请求），不在跨目录范围内复用。
    expect(lastKnownRunControlCatalog(new Map([
      ['opencode\u0000\u0000/repo', { ...catalogFor('/repo', now), providerId: 'opencode' as const }]
    ]), { providerId: 'opencode', cwd: '/other' })).toBeUndefined()
  })

  it('切换会话时直接显示最后已知权限与模型，且不以占位选择覆盖已保存偏好', () => {
    const piCatalog: AgentRunControlCatalog = {
      models: [{ model: { id: 'claude-sonnet-4' }, label: 'Sonnet', efforts: [{ id: 'high', label: 'High' }] }],
      permissions: [{ id: 'full_access', label: '本机完全访问', description: 'Pi 没有内置沙箱' }]
    }
    const catalogs = new Map<string, CapabilityEnvelope<AgentRunControlCatalog>>([
      ['pi\u0000pi:default\u0000/repo', {
        providerId: 'pi', agentProfileId: 'pi:default', cwd: '/repo', mode: 'read',
        state: 'ready', data: piCatalog, observedAt: now - 1_000
      }]
    ])
    const stored = { model: { id: 'claude-sonnet-4' }, effort: 'high', permissionMode: 'full_access' as const }

    const switched = resolveRunControlDisplay(catalogs, {
      providerId: 'pi', agentProfileId: 'pi:default', cwd: '/other-session'
    }, stored)
    expect(switched.capability?.state).toBe('unknown')
    expect(switched.controls).toEqual(stored)
    expect(switched.loading).toBe(false)
    expect(switched.persistSelection).toBe(false)
    expect(runControlSendBlockedReason('pi', switched.capability, switched.loading, switched.controls)).toBeNull()

    const sameContext = resolveRunControlDisplay(catalogs, {
      providerId: 'pi', agentProfileId: 'pi:default', cwd: '/repo'
    }, stored)
    expect(sameContext.capability?.state).toBe('ready')
    expect(sameContext.persistSelection).toBe(true)

    // 从没读过目录时仍然用占位目录并阻断发送，不猜测 Provider 能力。
    const cold = resolveRunControlDisplay(new Map(), { providerId: 'pi', agentProfileId: 'pi:default', cwd: '/repo' }, stored)
    expect(cold.capability).toBeNull()
    expect(cold.loading).toBe(true)
    // 从未读过目录时只能显示占位目录；此时仍 fail closed，不猜测 Provider 能力。
    expect(cold.controls.permissionMode).toBe('default')
    expect(runControlSendBlockedReason('pi', cold.capability, cold.loading, cold.controls)).toBe(
      '运行权限能力尚未确认，暂不能发送'
    )
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
    expect(runControlSendBlockedReason('qoder', retained, false, { permissionMode: 'default' })).toBeNull()
    expect(runControlSendBlockedReason('qoder', retained, false, {
      model: { id: 'ultimate' },
      permissionMode: 'default'
    })).toBeNull()
  })

  it('缓存复核传输失败时允许目录内的非默认权限，但拒绝不存在的权限', () => {
    const known = catalog('ultimate')
    known.permissions.push({ id: 'full_access', label: '完全访问', description: '允许执行工作区操作' })
    const retained = retainCachedRunControlCatalog(
      envelope('qoder', '/repo', known, now - 1_000),
      {
        providerId: 'qoder',
        cwd: '/repo',
        mode: 'read',
        state: 'unknown',
        data: null,
        reason: 'Transport closed'
      }
    )

    expect(runControlSendBlockedReason('qoder', retained, false, {
      model: { id: 'ultimate' },
      effort: 'high',
      permissionMode: 'full_access'
    })).toBeNull()
    expect(runControlSendBlockedReason('qoder', retained, false, {
      model: { id: 'ultimate' },
      permissionMode: 'auto_review'
    })).toBe('最后已知模型目录不包含当前模型、推理强度或权限，请重新选择')
  })
})
