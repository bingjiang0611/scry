import { describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptor } from '../shared/provider'
import { composeProviderDetectionResults, createCachedAsyncLoader } from './provider-detection'

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
      agentProfileId: 'pi:default',
      version: '0.84.4'
    })
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
})
