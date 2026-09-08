import { describe, expect, it, vi } from 'vitest'
import { requestDockBadgePermission } from './dock-badge-permission'

describe('requestDockBadgePermission', () => {
  it('首次发送时请求通知权限', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')

    await expect(requestDockBadgePermission({ permission: 'default', requestPermission })).resolves.toBe('settled')

    expect(requestPermission).toHaveBeenCalledOnce()
  })

  it('已有决定时不重复请求，权限异常也不阻断发送', async () => {
    const settledRequest = vi.fn()
    await expect(requestDockBadgePermission({ permission: 'denied', requestPermission: settledRequest }))
      .resolves.toBe('skipped')
    expect(settledRequest).not.toHaveBeenCalled()

    await expect(requestDockBadgePermission({
      permission: 'default',
      requestPermission: vi.fn().mockRejectedValue(new Error('unavailable'))
    })).resolves.toBe('settled')
  })

  // 真实故障：打包安装后 bundle 是“新 App”，通知授权处于 default；系统弹窗迟迟不返回时
  // requestPermission() 永不 resolve。发送路径曾经 await 它，于是按钮既不禁用也不报错，
  // 点击完全没反应。可选权限必须有界，不能挂住调用方。
  it('系统弹窗永不返回时有界退出，不挂住发送', async () => {
    const requestPermission = vi.fn(() => new Promise<NotificationPermission>(() => {}))
    let waited: number | undefined

    await expect(requestDockBadgePermission(
      { permission: 'default', requestPermission },
      { timeoutMs: 1_500, delay: async (ms) => { waited = ms } }
    )).resolves.toBe('timeout')

    expect(requestPermission).toHaveBeenCalledOnce()
    expect(waited).toBe(1_500)
  })
})
