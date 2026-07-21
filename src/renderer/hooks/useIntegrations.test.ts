import { describe, expect, it, vi } from 'vitest'
import type { CapabilityEnvelope } from '@shared/provider'
import { authoritativeRefreshAfterToggle } from './useIntegrations'

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
})
