import { describe, expect, it, vi } from 'vitest'
import { listCommands, listProviderControls } from './remote-gateway-catalog'
import { RemoteGatewayError } from './remote-gateway-types'

const PEER = 'a'.repeat(64)

function catalogContext(overrides: {
  selected?: (query: { providerId: string; cwd: string; agentProfileId?: string }) => Promise<unknown>
  commands?: (query: { providerId: string; cwd: string; agentProfileId?: string }) => Promise<{ commands: { name: string; description: string }[] }>
  authorize?: (peer: string) => void
} = {}) {
  const selected = vi.fn(overrides.selected ?? (async () => ({ id: 'pi', label: 'Pi', available: true, models: [] })))
  const commands = vi.fn(overrides.commands ?? (async () => ({ commands: [{ name: 'help', description: 'help' }] })))
  const authorize = vi.fn(overrides.authorize ?? ((peer: string) => {
    if (peer !== PEER) throw new RemoteGatewayError('device_not_authorized')
  }))
  return {
    selected,
    commands,
    authorize,
    context: {
      authorize,
      providers: { list: () => [{ id: 'pi', label: 'Pi', available: true }], selected: selected as never },
      commands: { list: commands as never }
    }
  }
}

describe('remote catalog single flight', () => {
  it('shares only a request that is still in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { context, selected } = catalogContext({
      selected: async () => { await gate; return { id: 'pi', label: 'Pi', available: true, models: [] } }
    })
    const query = { detail: 'selected' as const, providerId: 'pi', cwd: '/workspace' }
    const first = listProviderControls(context, PEER, query)
    const second = listProviderControls(context, PEER, query)
    expect(selected).toHaveBeenCalledTimes(1)
    release()
    const results = await Promise.all([first, second])
    expect(results[0]).toEqual(results[1])
    // A later refresh is a new read: capability state must never be reused.
    await listProviderControls(context, PEER, query)
    expect(selected).toHaveBeenCalledTimes(2)
  })

  it('keeps different selections separate and merges command reads per context', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { context, selected, commands } = catalogContext({
      selected: async () => { await gate; return { id: 'pi', label: 'Pi', available: true, models: [] } },
      commands: async () => { await gate; return { commands: [] } }
    })
    const pi = listProviderControls(context, PEER, { detail: 'selected', providerId: 'pi', cwd: '/workspace' })
    const codex = listProviderControls(context, PEER, { detail: 'selected', providerId: 'codex', cwd: '/workspace' })
    expect(selected).toHaveBeenCalledTimes(1)
    // Only the listed, available Provider may be resolved.
    await expect(codex).rejects.toThrow('provider_not_authorized')
    release()
    await pi
    const [a, b] = await Promise.all([
      listCommands(context, PEER, { providerId: 'pi', cwd: '/workspace' }),
      listCommands(context, PEER, { providerId: 'pi', cwd: '/workspace' })
    ])
    expect(commands).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    await listCommands(context, PEER, { providerId: 'pi', cwd: '/elsewhere' })
    expect(commands).toHaveBeenCalledTimes(2)
  })

  it('still rejects a caller whose grant was revoked while another read is shared', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let revoked = false
    const { context, selected } = catalogContext({
      selected: async () => { await gate; return { id: 'pi', label: 'Pi', available: true, models: [] } },
      authorize: (peer: string) => {
        if (peer !== PEER) throw new RemoteGatewayError('device_not_authorized')
        if (revoked) throw new RemoteGatewayError('device_not_authorized')
      }
    })
    const query = { detail: 'selected' as const, providerId: 'pi', cwd: '/workspace' }
    const authorized = listProviderControls(context, PEER, query)
    revoked = true
    // The second caller authorizes before it joins the shared read, so revocation
    // denies it even though the first read is still running.
    await expect(listProviderControls(context, PEER, query)).rejects.toThrow('device_not_authorized')
    release()
    await authorized
    expect(selected).toHaveBeenCalledTimes(1)
    await expect(listProviderControls(context, PEER, query)).rejects.toThrow('device_not_authorized')
  })
})
