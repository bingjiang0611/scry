import { describe, expect, it, vi } from 'vitest'
import { ProviderOperationGate } from '../../main/provider-operation-gate'

// The daemon has no browser: a re-auth's OAuth page goes to its App on the event feed.
// Main's own safety check runs first, here, so an unsafe page never leaves the daemon.

vi.mock('../../main/bootstrap/trust', () => ({
  ensureMcpExecutionAuthorized: vi.fn(async () => null),
  authorizedMcpExecution: vi.fn(() => undefined)
}))

const { mcpLocalOps } = await import('./mcp')

function group(url: string) {
  const events = { append: vi.fn() }
  const providerRegistry = {
    reauthenticateMcp: vi.fn(async (_context: unknown, _target: string, _execution: unknown, hooks: { openExternal(url: string): Promise<void> }) => {
      await hooks.openExternal(url)
      return { providerId: 'codex', state: 'ready', data: { ok: true, status: 'authenticated' } }
    })
  }
  const ops = mcpLocalOps({
    providers: { providerRegistry },
    session: { withProviderOperation: async (_id: unknown, operation: () => unknown) => operation(), canonicalProviderCwd: (cwd?: string) => cwd ?? '', providerOperationGate: new ProviderOperationGate() },
    workspace: { homeDir: '/home/u' },
    events,
    runs: () => ({ activeStates: () => [] })
  } as never)
  return { ops, events, providerRegistry }
}

describe('daemon MCP re-auth', () => {
  it('hands a safe OAuth page to the App on the event feed', async () => {
    const { ops, events } = group('https://auth.example.com/authorize')
    await expect(ops['agent:reauthenticateMcp']!({ context: { providerId: 'codex', cwd: '/w' }, targetId: 'srv' })).resolves.toMatchObject({ state: 'ready' })
    expect(events.append).toHaveBeenCalledWith({ kind: 'oauth', url: 'https://auth.example.com/authorize' })
  })

  it('refuses an unsafe page before anything reaches the App', async () => {
    const { ops, events } = group('http://evil.example.com/authorize')
    await expect(ops['agent:reauthenticateMcp']!({ context: { providerId: 'codex', cwd: '/w' }, targetId: 'srv' })).rejects.toThrow('不安全的 MCP OAuth 授权地址')
    expect(events.append).not.toHaveBeenCalled()
  })
})
