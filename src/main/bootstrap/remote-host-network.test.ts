import { describe, expect, it, vi } from 'vitest'

const listeners = vi.hoisted(() => new Map<string, () => void>())
vi.mock('electron', () => ({
  powerMonitor: { on: (event: string, listener: () => void) => { listeners.set(event, listener) } }
}))

import { watchRemoteRelayPower } from './remote-host-network'
import type { RemoteHostService } from '../remote/remote-host-service'

describe('remote relay power events', () => {
  it('drops phone lanes only after a wake; a screen unlock replaces idle legs alone', () => {
    const refreshRelay = vi.fn()
    watchRemoteRelayPower({ remoteHostService: { refreshRelay } as unknown as RemoteHostService })
    listeners.get('unlock-screen')?.()
    expect(refreshRelay).toHaveBeenLastCalledWith({ includeActive: false })
    listeners.get('resume')?.()
    expect(refreshRelay).toHaveBeenLastCalledWith({ includeActive: true })
    expect(refreshRelay).toHaveBeenCalledTimes(2)
  })
})
