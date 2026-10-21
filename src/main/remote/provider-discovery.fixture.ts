import { capabilityReady, type ProviderContext, type ProviderDescriptor } from '../../shared/provider'
import { createProviderDiscovery } from './provider-discovery'

export function providerDiscoveryFixture(overrides: Partial<Parameters<typeof createProviderDiscovery>[0]> = {}) {
  const calls: ProviderContext[] = []
  const errors: unknown[] = []
  const profiles = [{ id: 'pi:fixture', label: 'Pi fixture', executable: '/fixture/pi' }]
  const descriptors: ProviderDescriptor[] = [
    { id: 'pi', label: 'Pi', runtimeProvider: 'pi_rpc', transport: 'fixture', available: true, capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' } },
    { id: 'qoder', label: 'Qoder', runtimeProvider: 'qoder_cli', transport: 'fixture', available: true, capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' } },
    { id: 'opencode', label: 'OpenCode', runtimeProvider: 'opencode_server', transport: 'fixture', available: true, capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' } }
  ]
  const controls: Parameters<typeof createProviderDiscovery>[0]['controls'] = async (context) => {
    calls.push(context)
    return capabilityReady(context, 'read', { models: [], permissions: [{ id: 'default', label: 'Default', description: 'Fixture native approval' }] })
  }
  const discovery = createProviderDiscovery({
    descriptors: async () => descriptors,
    profiles: async () => profiles,
    resolveProfile: async (id) => profiles.find((profile) => profile.id === id),
    authorizeWorkspace: (cwd) => {
      if (cwd !== '/workspace' && cwd !== '/workspace-alias') throw new Error('workspace_not_authorized')
      return '/workspace'
    },
    controls,
    defaultWorkspace: () => '/workspace',
    permissionOverride: () => undefined,
    onError: (error) => { errors.push(error) },
    ...overrides
  })
  return { discovery, calls, errors, profiles, descriptors, controls }
}
