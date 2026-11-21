import { describe, expect, it, vi } from 'vitest'
import { setBackgroundServiceLoginStart, type LoginStartActionDeps } from './background-service-actions'
import { readBackgroundServiceStatus } from './background-service-status'
import type { BackgroundServiceRemoteConfig } from '../shared/background-service'

function loginStartDeps(overrides: Partial<LoginStartActionDeps> = {}): LoginStartActionDeps {
  return {
    
    precheckEnable: () => ({ ok: true, policyEnvKeys: ['SCRY_REMOTE_HOST'] }),
    confirmEnable: vi.fn(async () => true),
    isDaemonRunning: async () => true,
    enable: vi.fn(async () => ({ ok: true as const })),
    disable: vi.fn(async () => ({ ok: true as const })),
    ...overrides
  }
}

describe('setBackgroundServiceLoginStart action (P5-2)', () => {
  it('asks native confirmation before enabling and does nothing on cancel', async () => {
    const confirmEnable = vi.fn(async () => false)
    const enable = vi.fn(async () => ({ ok: true as const }))
    const result = await setBackgroundServiceLoginStart(true, loginStartDeps({ confirmEnable, enable }))
    expect(result).toEqual({ status: 'cancelled' })
    expect(confirmEnable).toHaveBeenCalledWith(['SCRY_REMOTE_HOST'])
    expect(enable).not.toHaveBeenCalled()
  })

  it('refuses secret env before showing any confirmation dialog', async () => {
    const confirmEnable = vi.fn(async () => true)
    const enable = vi.fn(async () => ({ ok: true as const }))
    const result = await setBackgroundServiceLoginStart(true, loginStartDeps({
      precheckEnable: () => ({ ok: false, reason: 'login_start_secret_env' }),
      confirmEnable,
      enable
    }))
    expect(result).toMatchObject({ status: 'failed', reason: 'login_start_secret_env' })
    expect((result as { message: string }).message).toContain('SCRY_REMOTE_RELAY_WS')
    expect(confirmEnable).not.toHaveBeenCalled()
    expect(enable).not.toHaveBeenCalled()
  })

  it('disables without asking confirmation and passes daemonRunning through', async () => {
    const confirmEnable = vi.fn(async () => true)
    const disable = vi.fn(async () => ({ ok: true as const }))
    const result = await setBackgroundServiceLoginStart(false, loginStartDeps({
      confirmEnable,
      isDaemonRunning: async () => true,
      disable
    }))
    expect(result).toEqual({ status: 'done' })
    expect(confirmEnable).not.toHaveBeenCalled()
    expect(disable).toHaveBeenCalledWith({ daemonRunning: true })
  })

  it('formats macOS bootstrap failure with Login Items hint, exit code, and machine code', async () => {
    const result = await setBackgroundServiceLoginStart(true, loginStartDeps({
      enable: async () => ({ ok: false, reason: 'login_start_bootstrap_failed', exitCode: 125 })
    }))
    expect(result).toMatchObject({ status: 'failed', reason: 'login_start_bootstrap_failed' })
    const message = (result as { message: string }).message
    expect(message).toContain('登录项')
    expect(message).toContain('125')
    expect(message).toContain('login_start_bootstrap_failed')
  })
})

describe('readBackgroundServiceStatus with loginStart, policy mismatch, and Linux MainPID verification', () => {
  const baseConfig: BackgroundServiceRemoteConfig = {
    remoteHostEnabled: true,
    relayMode: 'public',
    permissionModeOverride: null,
    disabledProviders: [],
    runControlsEnabled: true,
    providerManifestUrl: null
  }

  it('reports remoteConfigMismatch when adopting a service-launched daemon with different policy', async () => {
    const status = await readBackgroundServiceStatus({
      
      userDataDir: '/u',
      connection: async () => ({ state: 'ready' }),
      selfReport: async () => ({
        version: '2.0.0', pid: 1001, startedAt: 100, devices: { state: 'known', paired: 1 }, activeRuns: 0,
        launchedBy: 'service', supervisorPid: 1000,
        remoteConfig: { ...baseConfig, permissionModeOverride: 'auto_review' }
      }),
      lockHolder: async () => ({ pid: 1001 }),
      expectedRemoteConfig: () => baseConfig,
      loginStart: async () => ({ state: 'enabled', loaded: true, policyEnv: [] }),
      platform: 'darwin',
      now: () => 200
    })
    expect(status.mode).toBe('daemon')
    if (status.mode === 'daemon') {
      expect(status.launchedBy).toBe('service')
      expect(status.launchedByVerified).toBe(false)
      expect(status.runtimeNotice?.remoteConfigMismatch?.diffs).toEqual(['permissionModeOverride'])
    }
  })

  it('marks launchedByVerified true on Linux only when systemd MainPID matches self-reported supervisorPid', async () => {
    const matched = await readBackgroundServiceStatus({
      
      userDataDir: '/u',
      connection: async () => ({ state: 'ready' }),
      selfReport: async () => ({
        version: '2.0.0', pid: 1001, startedAt: 100, devices: { state: 'known', paired: 0 }, activeRuns: 0,
        launchedBy: 'service', supervisorPid: 900, remoteConfig: baseConfig
      }),
      lockHolder: async () => ({ pid: 1001 }),
      expectedRemoteConfig: () => baseConfig,
      loginStart: async () => ({ state: 'enabled', loaded: true, policyEnv: [], linuxLinger: 'no', linuxMainPid: 900 }),
      platform: 'linux',
      now: () => 200
    })
    expect(matched.mode === 'daemon' && matched.launchedByVerified).toBe(true)

    const mismatched = await readBackgroundServiceStatus({
      
      userDataDir: '/u',
      connection: async () => ({ state: 'ready' }),
      selfReport: async () => ({
        version: '2.0.0', pid: 1001, startedAt: 100, devices: { state: 'known', paired: 0 }, activeRuns: 0,
        launchedBy: 'service', supervisorPid: 900, remoteConfig: baseConfig
      }),
      lockHolder: async () => ({ pid: 1001 }),
      expectedRemoteConfig: () => baseConfig,
      loginStart: async () => ({ state: 'enabled', loaded: true, policyEnv: [], linuxLinger: 'no', linuxMainPid: 999 }),
      platform: 'linux',
      now: () => 200
    })
    expect(mismatched.mode === 'daemon' && mismatched.launchedByVerified).toBe(false)
  })
})
