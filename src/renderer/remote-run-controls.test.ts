import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteProviderRef } from '@shared/desktop-remote'
import { initialRemoteRunControls, readRemoteRunControls, remoteRunControlsKey, writeRemoteRunControls } from './remote-run-controls'

const provider: RemoteProviderRef = {
  id: 'pi', label: 'Pi', available: true,
  models: [
    { id: 'default', label: 'Default', isDefault: true },
    { id: 'chosen', providerId: 'upstream', label: 'Chosen', efforts: [{ id: 'high', label: 'High' }] }
  ],
  permissions: [{ id: 'full_access', label: 'Full access' }]
}
afterEach(() => vi.unstubAllGlobals())

describe('remote run control preferences', () => {
  it('restores model, effort and permission for a new session after remount/restart', () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) } })
    const key = remoteRunControlsKey('mac2', provider)
    const chosen = { model: { id: 'chosen', providerId: 'upstream' }, effort: 'high', permissionMode: 'full_access' as const }
    writeRemoteRunControls(key, chosen)
    expect(initialRemoteRunControls(provider, readRemoteRunControls(key))).toEqual(chosen)
  })
  it('does not share preferences across hosts, providers or profiles', () => {
    const keys = [remoteRunControlsKey('mac2', provider), remoteRunControlsKey('mac3', provider),
      remoteRunControlsKey('mac2', { ...provider, id: 'codex' }), remoteRunControlsKey('mac2', { ...provider, agentProfileId: 'profile' })]
    expect(new Set(keys).size).toBe(4)
  })
  it('selects the sole supported permission when no saved choice exists', () => {
    expect(initialRemoteRunControls(provider).permissionMode).toBe('full_access')
  })
  it('revalidates stored choices against the current host catalog', () => {
    expect(initialRemoteRunControls(provider, { model: { id: 'chosen', providerId: 'other' }, effort: 'removed', permissionMode: 'default' })).toEqual({
      model: { id: 'default' }, effort: undefined, permissionMode: 'full_access'
    })
  })
  it('ignores corrupt storage and keeps the live selection usable when storage is denied', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => '{', setItem: () => { throw new Error('denied') } } })
    expect(readRemoteRunControls('key')).toBeUndefined()
    expect(() => writeRemoteRunControls('key', { permissionMode: 'full_access' })).not.toThrow()
  })
})
