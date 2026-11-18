import { describe, expect, it, vi } from 'vitest'
import { registerProviderHandlers, type ProviderHandlersDependencies } from './provider-handlers'

// MCP test and re-auth are Provider operations. When the daemon switch is on, the daemon
// owns those processes: running them here would authenticate outside the daemon's auth
// queue, and its runs would not see the result. Until MCP moves into the daemon, the
// capability must be named absent rather than raced.

function harness() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const envelope = { providerId: 'claude', mode: 'read', state: 'ready', data: {} }
  const testMcp = vi.fn(async () => envelope)
  const reauthenticateMcp = vi.fn(async () => envelope)
  registerProviderHandlers({
    handleTrusted: (channel, listener) => { handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown) },
    providerRegistry: { testMcp, reauthenticateMcp, get: () => ({}), invalidateContext: async () => undefined } as unknown as ProviderHandlersDependencies['providerRegistry'],
    withProviderOperation: async (_providerId, operation) => await operation(),
    getRemoteProviderDiscovery: () => ({ invalidate: () => undefined }),
    refreshInvalidatedRemoteProviderMetadata: () => undefined,
    ensureMcpExecutionAuthorized: async () => null,
    authorizedMcpExecution: () => undefined,
    homeDir: '/home', getCurrentCwd: () => '/w', getRuns: () => ({ activeStates: () => [] }),
    canonicalProviderCwd: (cwd) => cwd ?? '/w',
    providerOperationKey: () => 'k',
    providerOperationGate: {} as ProviderHandlersDependencies['providerOperationGate']
  })
  const invoke = (channel: string, payload: unknown) => handlers.get(channel)!(null, payload)
  return { invoke, testMcp, reauthenticateMcp }
}

describe('MCP auth ownership', () => {
  it('names the capability absent when the daemon owns providers', async () => {
    const previous = process.env.SCRY_HOST_DAEMON
    process.env.SCRY_HOST_DAEMON = '1'
    try {
      const { invoke, testMcp, reauthenticateMcp } = harness()
      const context = { providerId: 'claude', cwd: '/w' }
      await expect(async () => await invoke('agent:testMcp', { context, targetId: 'td' })).rejects.toThrow('daemon_capability_unavailable:mcp-auth')
      await expect(async () => await invoke('agent:reauthenticateMcp', { context, targetId: 'td' })).rejects.toThrow('daemon_capability_unavailable:mcp-auth')
      // The point of the guard: no second auth flow, in this process, outside the queue.
      expect(testMcp).not.toHaveBeenCalled()
      expect(reauthenticateMcp).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.SCRY_HOST_DAEMON
      else process.env.SCRY_HOST_DAEMON = previous
    }
  })

  it('keeps the in-process path when the switch is off', async () => {
    const previous = process.env.SCRY_HOST_DAEMON
    delete process.env.SCRY_HOST_DAEMON
    try {
      const { invoke, testMcp } = harness()
      await invoke('agent:testMcp', { context: { providerId: 'claude', cwd: '/w' }, targetId: 'td' })
      expect(testMcp).toHaveBeenCalledTimes(1)
    } finally {
      if (previous !== undefined) process.env.SCRY_HOST_DAEMON = previous
    }
  })
})
