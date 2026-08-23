import { describe, expect, it, vi } from 'vitest'
import { requestDockBadgePermission } from './dock-badge-permission'

describe('requestDockBadgePermission', () => {
  it('首次发送时请求通知权限', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')

    await requestDockBadgePermission({ permission: 'default', requestPermission })

    expect(requestPermission).toHaveBeenCalledOnce()
  })

  it('已有决定时不重复请求，权限异常也不阻断发送', async () => {
    const settledRequest = vi.fn()
    await requestDockBadgePermission({ permission: 'denied', requestPermission: settledRequest })
    expect(settledRequest).not.toHaveBeenCalled()

    await expect(requestDockBadgePermission({
      permission: 'default',
      requestPermission: vi.fn().mockRejectedValue(new Error('unavailable'))
    })).resolves.toBeUndefined()
  })
})
