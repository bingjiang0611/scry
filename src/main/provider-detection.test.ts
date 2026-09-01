import { describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptor } from '../shared/provider'
import { composeProviderDetectionResults } from './provider-detection'

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
})
