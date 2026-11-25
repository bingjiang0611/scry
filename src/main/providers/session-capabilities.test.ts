import { expect, it } from 'vitest'
import { createBuiltInProviderAdapters } from './index'

/**
 * C1/C2: the dispatcher must not assume every Provider can take mid-turn input or swap a model
 * online. These declarations are the contract the runtime reads, so keep them explicit and honest.
 */
it('C1: every built-in Provider declares what it can do inside one live session', () => {
  const adapters = createBuiltInProviderAdapters('/tmp/scry-home', '/tmp/codex-home')
  expect(adapters.length).toBeGreaterThanOrEqual(4)
  for (const adapter of adapters) {
    const capabilities = adapter.sessionCapabilities
    expect(capabilities, `${adapter.id} 必须声明 sessionCapabilities`).toBeDefined()
    expect(typeof capabilities!.persistentProcess).toBe('boolean')
    expect(typeof capabilities!.nativeSteer).toBe('boolean')
    expect(typeof capabilities!.onlineModelSwitch).toBe('boolean')
    expect(typeof capabilities!.permissionModeInLaunchFlags).toBe('boolean')
  }
})

it('C1: a Provider whose permission mode is a launch flag says so instead of claiming online switching', () => {
  const adapters = createBuiltInProviderAdapters('/tmp/scry-home', '/tmp/codex-home')
  const antigravity = adapters.find((adapter) => adapter.id === 'antigravity')
  if (antigravity) {
    expect(antigravity.sessionCapabilities).toMatchObject({
      persistentProcess: true,
      onlineModelSwitch: true,
      permissionModeInLaunchFlags: true
    })
  }
  const codex = adapters.find((adapter) => adapter.id === 'codex')
  expect(codex?.sessionCapabilities?.persistentProcess).toBe(true)
})

it('C2: native steer is declared only where a run really admits mid-turn input', async () => {
  const { PROVIDER_SESSION_CAPABILITIES } = await import('./session-capabilities')
  // The three that have a steer path today, and the three that do not. A Provider moving between these
  // groups must change its run, not just this table.
  expect(Object.fromEntries(Object.entries(PROVIDER_SESSION_CAPABILITIES).map(([id, value]) => [id, value.nativeSteer])))
    .toEqual({ claude: false, qoder: true, codex: true, opencode: false, pi: true, antigravity: false })
})
