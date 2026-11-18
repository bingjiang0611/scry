import { describe, expect, it, vi } from 'vitest'
import { MCP_CHECK_CANCELLED } from '../../shared/provider'
import { ProviderOperationGate } from '../provider-operation-gate'
import { mcpChannelHandlers, type McpChannelDependencies } from './mcp-channels'

// A live MCP check is registered by Provider profile and workspace, and cancelling it
// reaches only that check. The same table runs in main and in the daemon, so the cancel
// must find the check in whichever process holds it.

function harness() {
  let release: () => void = () => undefined
  const seen: { signal?: AbortSignal } = {}
  const mcpSnapshot = vi.fn(async (_context: unknown, _refresh: boolean, _execution: unknown, signal?: AbortSignal) => {
    seen.signal = signal
    await new Promise<void>((resolve) => { release = resolve; signal?.addEventListener('abort', () => resolve()) })
    return { providerId: 'claude', mode: 'read', state: signal?.aborted ? 'unknown' : 'ready', data: null }
  })
  const handlers = mcpChannelHandlers({
    providerRegistry: { mcpSnapshot } as unknown as McpChannelDependencies['providerRegistry'],
    withProviderOperation: async (_providerId, operation) => await operation(),
    ensureMcpExecutionAuthorized: async () => null,
    authorizedMcpExecution: () => undefined,
    homeDir: '/home', getRuns: () => ({ activeStates: () => [] }),
    canonicalProviderCwd: (cwd) => cwd ?? '/w',
    providerOperationGate: new ProviderOperationGate(),
    openExternal: async () => undefined,
    assertOwner: () => undefined
  })
  return { handlers, mcpSnapshot, seen, release: () => release() }
}

describe('MCP live check cancel', () => {
  it('aborts the running check of that profile and workspace, and says so', async () => {
    const { handlers, seen } = harness()
    const context = { providerId: 'claude' as const, cwd: '/w' }
    const running = handlers['agent:mcpSnapshot']({ context, refresh: true })
    await vi.waitFor(() => expect(seen.signal).toBeDefined())
    expect(await handlers['agent:cancelMcpSnapshot'](context)).toBe(true)
    expect(seen.signal?.aborted).toBe(true)
    await running
    // Nothing is left to cancel once the check has ended.
    expect(await handlers['agent:cancelMcpSnapshot'](context)).toBe(false)
  })

  it('leaves a check in another workspace running', async () => {
    const { handlers, seen, release } = harness()
    const running = handlers['agent:mcpSnapshot']({ context: { providerId: 'claude', cwd: '/w' }, refresh: true })
    await vi.waitFor(() => expect(seen.signal).toBeDefined())
    expect(await handlers['agent:cancelMcpSnapshot']({ providerId: 'claude', cwd: '/other' })).toBe(false)
    expect(seen.signal?.aborted).toBe(false)
    release()
    await running
  })

  it('refuses for a Provider whose check cannot be cancelled, aborting nothing', async () => {
    const { handlers, mcpSnapshot, seen, release } = harness()
    const context = { providerId: 'codex' as const, cwd: '/w' }
    const running = handlers['agent:mcpSnapshot']({ context, refresh: true })
    await vi.waitFor(() => expect(mcpSnapshot).toHaveBeenCalled())
    expect(await handlers['agent:cancelMcpSnapshot'](context)).toBe(false)
    expect(seen.signal?.aborted).toBe(false)
    release()
    await running
  })

  it('does not start a check that was cancelled before the Provider operation began', async () => {
    const mcpSnapshot = vi.fn()
    const context = { providerId: 'claude' as const, cwd: '/w' }
    let admit: () => void = () => undefined
    const gated = mcpChannelHandlers({
      providerRegistry: { mcpSnapshot } as unknown as McpChannelDependencies['providerRegistry'],
      withProviderOperation: async (_providerId, operation) => { await new Promise<void>((resolve) => { admit = resolve }); return await operation() },
      ensureMcpExecutionAuthorized: async () => null,
      authorizedMcpExecution: () => undefined,
      homeDir: '/home', getRuns: () => ({ activeStates: () => [] }),
      canonicalProviderCwd: (cwd) => cwd ?? '/w',
      providerOperationGate: new ProviderOperationGate(),
      openExternal: async () => undefined,
      assertOwner: () => undefined
    })
    const queued = gated['agent:mcpSnapshot']({ context, refresh: true })
    expect(await gated['agent:cancelMcpSnapshot'](context)).toBe(true)
    admit()
    await expect(queued).resolves.toMatchObject({ state: 'unknown', reason: MCP_CHECK_CANCELLED })
    expect(mcpSnapshot).not.toHaveBeenCalled()
  })
})
