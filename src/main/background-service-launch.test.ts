import { describe, expect, it, vi } from 'vitest'
import { createServiceLaunchController } from './background-service-launch'

describe('background service launch via service manager with direct fallback (P5 §2.4)', () => {
  it('uses service manager when installed and clears any previous fallback on success', async () => {
    const startViaService = vi.fn(async () => ({ ok: true as const }))
    const spawnDirect = vi.fn(() => ({ status: 'started' as const }))
    const notices: unknown[] = []
    const controller = createServiceLaunchController({
      canLaunchViaService: () => true,
      startViaService,
      spawnDirect,
      onFallbackChange: (fallback) => { notices.push(fallback) }
    })

    expect(await controller.launch()).toEqual({ status: 'started' })
    expect(startViaService).toHaveBeenCalledTimes(1)
    expect(spawnDirect).not.toHaveBeenCalled()
    expect(controller.usedServiceManager()).toBe(true)
    expect(controller.latestFallback()).toBeUndefined()
  })

  it('falls back to direct spawn immediately when service manager fails and records reason + exit code', async () => {
    const startViaService = vi.fn(async () => ({
      ok: false as const, reason: 'login_start_service_launch_failed', exitCode: 113
    }))
    const spawnDirect = vi.fn(() => ({ status: 'started' as const }))
    const notices: unknown[] = []
    const controller = createServiceLaunchController({
      canLaunchViaService: () => true,
      startViaService,
      spawnDirect,
      onFallbackChange: (fallback) => { notices.push(fallback) }
    })

    expect(await controller.launch()).toEqual({ status: 'started' })
    expect(startViaService).toHaveBeenCalledTimes(1)
    expect(spawnDirect).toHaveBeenCalledTimes(1)
    expect(controller.usedServiceManager()).toBe(false)
    expect(controller.latestFallback()).toEqual({ reason: 'login_start_service_launch_failed', exitCode: 113 })
    expect(notices).toEqual([{ reason: 'login_start_service_launch_failed', exitCode: 113 }])
  })

  it('falls back to direct spawn once when a service-manager launch times out waiting for ready', async () => {
    const startViaService = vi.fn(async () => ({ ok: true as const }))
    const spawnDirect = vi.fn(() => ({ status: 'started' as const }))
    const notices: unknown[] = []
    const controller = createServiceLaunchController({
      canLaunchViaService: () => true,
      startViaService,
      spawnDirect,
      onFallbackChange: (fallback) => { notices.push(fallback) }
    })

    expect(await controller.launch()).toEqual({ status: 'started' })
    expect(controller.usedServiceManager()).toBe(true)

    expect(await controller.fallbackAfterTimeout()).toEqual({ status: 'started' })
    expect(spawnDirect).toHaveBeenCalledTimes(1)
    expect(controller.usedServiceManager()).toBe(false)
    expect(controller.latestFallback()).toEqual({ reason: 'login_start_service_ready_timeout' })
    expect(notices).toEqual([{ reason: 'login_start_service_ready_timeout' }])
  })

  it('spawns directly without touching service manager when login-start is not installed', async () => {
    const startViaService = vi.fn(async () => ({ ok: true as const }))
    const spawnDirect = vi.fn(() => ({ status: 'started' as const }))
    const controller = createServiceLaunchController({
      canLaunchViaService: () => false,
      startViaService,
      spawnDirect
    })

    expect(await controller.launch()).toEqual({ status: 'started' })
    expect(startViaService).not.toHaveBeenCalled()
    expect(spawnDirect).toHaveBeenCalledTimes(1)
    expect(controller.usedServiceManager()).toBe(false)
    expect(await controller.fallbackAfterTimeout()).toEqual({ status: 'failed', reason: 'daemon_ready_timeout' })
  })
})
