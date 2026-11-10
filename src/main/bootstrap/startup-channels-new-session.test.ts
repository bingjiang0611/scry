import { afterEach, describe, expect, it, vi } from 'vitest'
import { gateDaemonChannel, installDaemonChannelForwarder } from '../daemon-channel-gate'
import { resetProviderSession, viewNothingAfterDaemonNewSession } from './startup-channels'

// agent:newSession: the sidebar's "new session". In daemon mode it was refused with the
// raw IPC wrapper; the daemon now resets the context it runs and the window keeps its
// own part, viewing no session.

const ON = { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv

describe('new session', () => {
  let undo: Array<() => void> = []
  afterEach(() => { for (const step of undo.splice(0)) step() })

  it('forgets the context session and the Provider warm state, in the given or current directory', async () => {
    const deps = {
      providerRegistry: { invalidateContext: vi.fn(async () => undefined) },
      providerContextKey: (providerId: string, cwd: string, profile?: string) => `${providerId}|${cwd}|${profile ?? ''}`,
      resetSessionContext: vi.fn(),
      currentCwd: () => '/current'
    }
    await expect(resetProviderSession(deps, { providerId: 'codex' })).resolves.toBe(true)
    expect(deps.resetSessionContext).toHaveBeenCalledWith('codex|/current|')
    expect(deps.providerRegistry.invalidateContext).toHaveBeenCalledWith({ providerId: 'codex', cwd: '/current' })
    await resetProviderSession(deps, { providerId: 'pi', agentProfileId: 'pi:0123456789abcdef', cwd: '/w' })
    expect(deps.resetSessionContext).toHaveBeenLastCalledWith('pi|/w|pi:0123456789abcdef')
    // No Provider named: nothing to reset, still a plain answer.
    deps.resetSessionContext.mockClear()
    await expect(resetProviderSession(deps, undefined)).resolves.toBe(true)
    expect(deps.resetSessionContext).not.toHaveBeenCalled()
  })

  it('in daemon mode, views no session only once the daemon answered', async () => {
    const badge = { view: vi.fn() }
    undo.push(viewNothingAfterDaemonNewSession(badge, () => true))
    const forwarder = vi.fn(async () => true)
    undo.push(installDaemonChannelForwarder(forwarder))
    const gated = gateDaemonChannel('agent:newSession', vi.fn(), ON) as unknown as (event: unknown, ...args: unknown[]) => Promise<unknown>
    await expect(gated({}, { providerId: 'codex', cwd: '/w' })).resolves.toBe(true)
    expect(forwarder).toHaveBeenCalledWith({ op: 'providerContext', method: 'newSession', args: [{ providerId: 'codex', cwd: '/w' }], read: false })
    expect(badge.view).toHaveBeenCalledWith(null, true)

    badge.view.mockClear()
    undo.push(installDaemonChannelForwarder(async () => { throw new Error('daemon_not_running') }))
    await expect(gated({}, { providerId: 'codex' })).rejects.toThrow('daemon_not_running')
    expect(badge.view).not.toHaveBeenCalled()
  })
})
