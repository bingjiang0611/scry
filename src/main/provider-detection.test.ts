import { describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptor } from '../shared/provider'
import { composeProviderDetectionResults, createCachedAsyncLoader, fastProviderDetectionResults } from './provider-detection'

const descriptor = (
  id: ProviderDescriptor['id'],
  label: string,
  runtimeProvider: ProviderDescriptor['runtimeProvider'],
  transport: string
): ProviderDescriptor => ({
  id,
  label,
  runtimeProvider,
  transport,
  available: true,
  version: id === 'pi' ? '0.84.4' : '2.1.170',
  capabilities: { skills: 'read', mcp: 'read', commands: 'none', account: 'none' },
  health: { state: 'ready', transport }
})

describe('Provider 探测缓存', () => {
  it('合并并发请求并在 TTL 内复用最后一次成功结果', async () => {
    let now = 1_000
    let resolveLoad: ((value: string) => void) | undefined
    const loader = vi.fn(() => new Promise<string>((resolve) => { resolveLoad = resolve }))
    const cached = createCachedAsyncLoader(loader, { ttlMs: 60_000, now: () => now })

    const first = cached.load()
    const concurrent = cached.load()
    await Promise.resolve()
    expect(loader).toHaveBeenCalledOnce()
    resolveLoad?.('ready')
    await expect(Promise.all([first, concurrent])).resolves.toEqual(['ready', 'ready'])

    now += 59_999
    await expect(cached.load()).resolves.toBe('ready')
    expect(loader).toHaveBeenCalledOnce()
  })

  it('TTL 到期或显式失效后重新加载，且不缓存失败', async () => {
    let now = 1_000
    const loader = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce('second')
      .mockResolvedValueOnce('third')
      .mockResolvedValueOnce('fourth')
    const cached = createCachedAsyncLoader(loader, { ttlMs: 100, now: () => now })

    await expect(cached.load()).rejects.toThrow('temporary failure')
    await expect(cached.load()).resolves.toBe('second')
    expect(loader).toHaveBeenCalledTimes(2)

    now += 100
    await expect(cached.load()).resolves.toBe('third')
    cached.invalidate()
    await expect(cached.load()).resolves.toBe('fourth')
    expect(loader).toHaveBeenCalledTimes(4)
  })

  it.each([false, true])('does not publish a superseded pending result (old read fails=%s)', async (fails) => {
    let resolveOld!: (value: string) => void
    let rejectOld!: (error: Error) => void
    const old = new Promise<string>((resolve, reject) => { resolveOld = resolve; rejectOld = reject })
    const loader = vi.fn<() => Promise<string>>().mockReturnValueOnce(old).mockResolvedValue('fresh')
    const cached = createCachedAsyncLoader(loader, { ttlMs: 60_000 })
    const first = cached.load()
    await Promise.resolve()
    cached.invalidate()
    const current = cached.load()
    expect(loader).toHaveBeenCalledTimes(1)
    if (fails) {
      rejectOld(new Error('superseded failure'))
      await expect(first).rejects.toThrow('superseded failure')
    } else {
      resolveOld('old')
      await expect(first).resolves.toBe('old')
    }
    await expect(current).resolves.toBe('fresh')
    await expect(cached.load()).resolves.toBe('fresh')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('零 TTL 只合并在途请求，不阻止下一次定时刷新', async () => {
    const loader = vi.fn().mockResolvedValue('snapshot')
    const refresh = createCachedAsyncLoader(loader, { ttlMs: 0 })

    await Promise.all([refresh.load(), refresh.load()])
    await refresh.load()
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

describe('Provider 完整探测结果组装', () => {
  it('版本探测返回超时状态时仍组装最终结果，并保留内置与自定义 Pi Profile', async () => {
    const probeStoredPiProfile = vi.fn().mockResolvedValue({
      health: {
        state: 'unavailable' as const,
        transport: 'CLI version probe',
        lastError: '版本探测超时（5s）'
      }
    })

    const result = await composeProviderDetectionResults({
      detected: [{
        id: 'claude',
        name: 'Claude Code',
        bin: 'claude',
        path: '/Users/example/.local/bin/claude',
        health: {
          state: 'unavailable',
          transport: 'CLI version probe',
          lastError: '版本探测超时（5s）'
        }
      }, {
        id: 'pi:default',
        name: 'Pi',
        bin: 'pi',
        path: '/Users/example/.local/bin/pi',
        version: '0.84.4',
        health: { state: 'ready', transport: 'CLI version probe' }
      }],
      descriptors: [
        descriptor('claude', 'Claude Code', 'claude_sdk', 'Agent SDK'),
        descriptor('pi', 'Pi', 'pi_rpc', 'JSONL RPC subprocess')
      ],
      storedPiProfiles: [{
        id: 'pi:25f2d533d0a8b391',
        label: 'Pi · pi-agent',
        executable: '/Users/example/dev-agent/pi-agent/bin/pi-agent'
      }],
      probeStoredPiProfile
    })

    expect(result.map((agent) => agent.id)).toEqual([
      'claude',
      'pi:default',
      'pi:25f2d533d0a8b391'
    ])
    expect(result[0].health).toMatchObject({
      state: 'unavailable',
      transport: 'Agent SDK',
      lastError: '版本探测超时（5s）'
    })
    expect(result[1]).toMatchObject({
      id: 'pi:default',
      version: '0.84.4'
    })
    // 历史内置 id 不是已登记的 Agent Profile：没有同一启动器的 Profile 就不报。
    expect(result[1].agentProfileId).toBeUndefined()
    expect(result[2]).toMatchObject({
      id: 'pi:25f2d533d0a8b391',
      name: 'Pi · pi-agent',
      bin: 'pi-agent',
      agentProfileId: 'pi:25f2d533d0a8b391',
      health: {
        state: 'unavailable',
        transport: 'JSONL RPC subprocess',
        lastError: '版本探测超时（5s）'
      }
    })
    expect(probeStoredPiProfile).toHaveBeenCalledOnce()
  })

  // 回归：截图里的发送失败。发现层保留历史 id（Pi · Rotom），但统一对话发送必须用已登记 Profile，
  // 而两者是同一个 canonical 启动器时才映射；不合并 id，存储 Profile 条目继续保留。
  it('reports the registered profile of a detected legacy Pi id on the same canonical launcher', async () => {
    const launcher = '/Users/example/.local/bin/rotom'
    const result = await composeProviderDetectionResults({
      detected: [{ id: 'pi:rotom', name: 'Pi · Rotom', bin: 'rotom', path: launcher, version: '0.1.26',
        health: { state: 'ready', transport: 'CLI version probe' } }],
      descriptors: [descriptor('pi', 'Pi', 'pi_rpc', 'JSONL RPC subprocess')],
      storedPiProfiles: [{ id: 'pi:0123456789abcdef', label: 'Pi · rotom', executable: launcher }],
      probeStoredPiProfile: vi.fn().mockResolvedValue({ health: { state: 'ready' as const, transport: 'CLI version probe' } })
    })

    expect(result.map((agent) => agent.id)).toEqual(['pi:rotom', 'pi:0123456789abcdef'])
    expect(result[0]).toMatchObject({ id: 'pi:rotom', name: 'Pi · Rotom', agentProfileId: 'pi:0123456789abcdef' })
    expect(result[1]).toMatchObject({ id: 'pi:0123456789abcdef', agentProfileId: 'pi:0123456789abcdef' })
  })

  it('reports no profile for a legacy Pi id whose launcher is not registered exactly', async () => {
    const result = await composeProviderDetectionResults({
      detected: [{ id: 'pi:rotom', name: 'Pi · Rotom', bin: 'rotom', path: '/Users/example/.local/bin/rotom' }],
      descriptors: [descriptor('pi', 'Pi', 'pi_rpc', 'JSONL RPC subprocess')],
      storedPiProfiles: [{ id: 'pi:0123456789abcdef', label: 'Pi · other', executable: '/Users/example/dev-agent/bin/pi-agent' }],
      probeStoredPiProfile: vi.fn().mockResolvedValue({ health: { state: 'ready' as const, transport: 'CLI version probe' } })
    })

    // 另一个 Pi 启动器不是这个 Agent 的身份；不猜同一个 Provider 的邻居。
    expect(result[0]).toMatchObject({ id: 'pi:rotom' })
    expect(result[0].agentProfileId).toBeUndefined()
  })

  it('reports no profile when two registered profiles share one launcher', async () => {
    const shared = '/Users/example/.local/bin/rotom'
    const result = await composeProviderDetectionResults({
      detected: [{ id: 'pi:rotom', name: 'Pi · Rotom', bin: 'rotom', path: shared }],
      descriptors: [descriptor('pi', 'Pi', 'pi_rpc', 'JSONL RPC subprocess')],
      storedPiProfiles: [
        { id: 'pi:0123456789abcdef', label: 'Pi · rotom', executable: shared },
        { id: 'pi:fedcba9876543210', label: 'Pi · rotom copy', executable: shared }
      ],
      probeStoredPiProfile: vi.fn().mockResolvedValue({ health: { state: 'ready' as const, transport: 'CLI version probe' } })
    })

    expect(result[0].agentProfileId).toBeUndefined()
  })

  it('keeps an already registered Pi id as its own profile', async () => {
    const result = await composeProviderDetectionResults({
      detected: [{ id: 'pi:0123456789abcdef', name: 'Pi · rotom', bin: 'rotom', path: '/bin/rotom' }],
      descriptors: [descriptor('pi', 'Pi', 'pi_rpc', 'JSONL RPC subprocess')],
      storedPiProfiles: [{ id: 'pi:0123456789abcdef', label: 'Pi · rotom', executable: '/bin/rotom' }],
      probeStoredPiProfile: vi.fn()
    })

    expect(result.map((agent) => agent.id)).toEqual(['pi:0123456789abcdef'])
    expect(result[0].agentProfileId).toBe('pi:0123456789abcdef')
  })

  it('缺少 Pi descriptor 时不伪造自定义 Profile', async () => {
    const probeStoredPiProfile = vi.fn().mockResolvedValue({
      version: '0.84.4',
      health: { state: 'ready' as const, transport: 'CLI version probe' }
    })

    const result = await composeProviderDetectionResults({
      detected: [],
      descriptors: [],
      storedPiProfiles: [{
        id: 'pi:25f2d533d0a8b391',
        label: 'Pi · pi-agent',
        executable: '/Users/example/dev-agent/pi-agent/bin/pi-agent'
      }],
      probeStoredPiProfile
    })

    expect(result).toEqual([])
    expect(probeStoredPiProfile).toHaveBeenCalledOnce()
  })

  it('已装但未注册的 Provider 以带原因的影子快照出现，而不是静默消失', async () => {
    const result = await composeProviderDetectionResults({
      detected: [{
        id: 'codex',
        name: 'Codex',
        bin: 'codex',
        path: '/Users/example/.local/bin/codex',
        version: '0.160.1',
        health: { state: 'ready', transport: 'CLI version probe' }
      }],
      descriptors: [],
      storedPiProfiles: [],
      probeStoredPiProfile: vi.fn()
    })

    expect(result).toEqual([expect.objectContaining({
      id: 'codex',
      name: 'Codex',
      path: '/Users/example/.local/bin/codex',
      version: '0.160.1',
      runtimeProvider: 'codex_cli',
      unavailableReason: '本构建未注册 codex Provider adapter',
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }
    })])
    // renderer 按 health.state 判定可选与否，影子快照必须是 unavailable
    expect(result[0].health).toMatchObject({ state: 'unavailable', lastError: expect.stringContaining('未注册') })
  })

  it('descriptor 上的兼容性建议与不可用原因会传到探测结果', async () => {
    const base = descriptor('codex', 'Codex', 'codex_cli', 'Codex CLI')
    const result = await composeProviderDetectionResults({
      detected: [{ id: 'codex', name: 'Codex', bin: 'codex', path: '/bin/codex', version: '0.160.1' }],
      descriptors: [{
        ...base,
        available: false,
        unavailableReason: 'Provider 描述失败：boom',
        compatibility: {
          status: 'unsupported',
          observedVersion: '0.160.1',
          recommendedRange: '>=0.161.0',
          matchedRange: '>=0.160.0',
          reason: '未验证版本',
          source: 'bundled',
          manifestUpdatedAt: '2026-10-15T00:00:00.000Z'
        }
      }],
      storedPiProfiles: [],
      probeStoredPiProfile: vi.fn()
    })

    expect(result[0]).toMatchObject({
      unavailableReason: 'Provider 描述失败：boom',
      compatibility: { status: 'unsupported', reason: '未验证版本' }
    })
  })

  // 真实实例回归：adapter 描述自己时往往还不知道版本，本机真实版本只有 CLI 探测这一步有。
  // 用 descriptor 的空版本算出来的 advisory 永远是 unknown，等于这套判定在真机上从不生效。
  it('用探测到的真实 CLI 版本重算兼容性，而不是沿用 descriptor 的空版本结论', async () => {
    const base = descriptor('qoder', 'Qoder', 'qoder_cli', 'Qoder Agent SDK')
    const compatibility = vi.fn((_providerId: ProviderDescriptor['id'], version: string | undefined) => ({
      status: version === '1.1.60' ? ('unsupported' as const) : ('unknown' as const),
      observedVersion: version ?? null,
      recommendedRange: '>=1.1.60 <1.2.0',
      matchedRange: version === '1.1.60' ? '<1.2.0' : null,
      reason: version === '1.1.60' ? '这个版本只验证过版本探测' : '未探测到 CLI 版本',
      source: 'bundled' as const,
      manifestUpdatedAt: '2026-10-15T00:00:00.000Z'
    }))
    const result = await composeProviderDetectionResults({
      detected: [{ id: 'qoder', name: 'Qoder', bin: 'qodercli', path: '/bin/qodercli', version: '1.1.60' }],
      descriptors: [{
        ...base,
        version: undefined,
        compatibility: {
          status: 'unknown',
          observedVersion: null,
          recommendedRange: '>=1.1.60 <1.2.0',
          matchedRange: null,
          reason: '未探测到 CLI 版本',
          source: 'bundled',
          manifestUpdatedAt: '2026-10-15T00:00:00.000Z'
        }
      }],
      storedPiProfiles: [],
      probeStoredPiProfile: vi.fn(),
      compatibility
    })

    expect(compatibility).toHaveBeenCalledWith('qoder', '1.1.60')
    expect(result[0]).toMatchObject({
      version: '1.1.60',
      compatibility: { status: 'unsupported', observedVersion: '1.1.60', reason: '这个版本只验证过版本探测' }
    })
  })

  it('没探到版本时不编造判定，沿用 descriptor 的结论', async () => {
    const base = descriptor('qoder', 'Qoder', 'qoder_cli', 'Qoder Agent SDK')
    const compatibility = vi.fn()
    const result = await composeProviderDetectionResults({
      detected: [{ id: 'qoder', name: 'Qoder', bin: 'qodercli', path: '/bin/qodercli' }],
      descriptors: [{ ...base, version: undefined }],
      storedPiProfiles: [],
      probeStoredPiProfile: vi.fn(),
      compatibility
    })

    expect(compatibility).not.toHaveBeenCalled()
    expect(result[0].compatibility).toBeUndefined()
  })
})

describe('Provider 快速探测结果组装', () => {
  // 回归：冷启动首屏显示的 Pi · Rotom 必须已经带上可发送的已登记 Profile。
  it('maps a detected legacy Pi id to the registered profile on the same canonical launcher', () => {
    const launcher = '/Users/example/.local/bin/rotom'
    const result = fastProviderDetectionResults([
      { id: 'claude', name: 'Claude Code', bin: 'claude', path: '/bin/claude' },
      { id: 'pi:rotom', name: 'Pi · Rotom', bin: 'rotom', path: launcher }
    ], [{ id: 'pi:0123456789abcdef', label: 'Pi · rotom', executable: launcher }])

    expect(result.map((agent) => agent.id)).toEqual(['claude', 'pi:rotom', 'pi:0123456789abcdef'])
    expect(result[0].agentProfileId).toBeUndefined()
    expect(result[1]).toMatchObject({ id: 'pi:rotom', agentProfileId: 'pi:0123456789abcdef' })
    expect(result[2]).toMatchObject({ id: 'pi:0123456789abcdef', agentProfileId: 'pi:0123456789abcdef',
      path: launcher, bin: 'rotom', name: 'Pi · rotom', runtimeProvider: 'pi_rpc' })
  })

  it('never reports a historical id as an Agent Profile', () => {
    const result = fastProviderDetectionResults([
      { id: 'pi:default', name: 'Pi', bin: 'pi', path: '/bin/pi' },
      { id: 'pi:rotom', name: 'Pi · Rotom', bin: 'rotom', path: '/bin/rotom' }
    ], [{ id: 'pi:0123456789abcdef', label: 'Pi · other', executable: '/bin/other' }])

    expect(result.filter((agent) => agent.id.startsWith('pi:'))
      .map((agent) => [agent.id, agent.agentProfileId])).toEqual([
      ['pi:default', undefined],
      ['pi:rotom', undefined],
      ['pi:0123456789abcdef', 'pi:0123456789abcdef']
    ])
  })

  it('drops an agent without a Provider adapter instead of inventing one', () => {
    expect(fastProviderDetectionResults([{ id: 'unknown', name: 'Unknown', bin: 'u', path: '/bin/u' }], [])).toEqual([])
  })
})
