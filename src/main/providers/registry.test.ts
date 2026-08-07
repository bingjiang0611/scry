import { describe, expect, it, vi } from 'vitest'
import type { ProviderAdapter } from './types'
import { parseDisabledProviders, ProviderRegistry } from './registry'

function adapter(id: 'claude' | 'codex'): ProviderAdapter {
  return {
    id,
    runtimeProvider: id === 'claude' ? 'claude_sdk' : 'codex_cli',
    describe: async () => ({
      id,
      label: id,
      runtimeProvider: id === 'claude' ? 'claude_sdk' : 'codex_cli',
      transport: 'test',
      available: true,
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }
    }),
    run: () => ({
      promise: Promise.resolve({ externalSessionId: 'session-1' }),
      interrupt: vi.fn(),
      getExternalSessionId: () => 'session-1'
    })
  }
}

describe('ProviderRegistry', () => {
  it('rejects duplicate provider ids', () => {
    expect(() => new ProviderRegistry([adapter('claude'), adapter('claude')])).toThrow('duplicate provider adapter')
  })

  it('stamps provider identity on emitted trace events', () => {
    const base = adapter('codex')
    base.run = (request) => {
      request.emit({ id: 'event-1', runId: request.runId, ts: '2026-07-10T00:00:00.000Z', kind: 'model', stage: 'text' })
      return { promise: Promise.resolve({}), interrupt: () => {}, getExternalSessionId: () => undefined }
    }
    const emit = vi.fn()
    new ProviderRegistry([base]).run('codex', { runId: 'run-1', prompt: 'hi', attachments: [], emit })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'codex', runtimeProvider: 'codex_cli' }))
  })

  it('returns explicit unsupported envelopes for missing facets', async () => {
    const registry = new ProviderRegistry([adapter('codex')])
    await expect(registry.listCommands({ providerId: 'codex', cwd: '/repo' })).resolves.toMatchObject({
      providerId: 'codex',
      state: 'unsupported',
      mode: 'none',
      data: null
    })
    await expect(registry.setSkillEnabled({ providerId: 'codex', cwd: '/repo' }, 'audit', false)).resolves.toMatchObject({
      state: 'unsupported',
      mode: 'none',
      data: null
    })
    await expect(registry.setMcpEnabled({ providerId: 'codex', cwd: '/repo' }, 'scry-e2e', false)).resolves.toMatchObject({
      state: 'unsupported',
      mode: 'none',
      data: null
    })
    await expect(registry.reauthenticateMcp(
      { providerId: 'codex', cwd: '/repo' },
      'scry-e2e',
      undefined,
      { openExternal: vi.fn(), prepareLoopbackCallback: vi.fn() }
    )).resolves.toMatchObject({
      state: 'unsupported',
      mode: 'none',
      data: null
    })
    await expect(registry.runControls({ providerId: 'codex', cwd: '/repo' })).resolves.toMatchObject({
      state: 'unsupported',
      data: null
    })
  })

  it('routes MCP authentication through the exact provider facet', async () => {
    const reauthenticate = vi.fn().mockResolvedValue({
      providerId: 'codex',
      cwd: '/repo',
      mode: 'read',
      state: 'ready',
      data: { ok: true, status: 'authenticated' }
    })
    const base: ProviderAdapter = {
      ...adapter('codex'),
      mcp: {
        snapshot: vi.fn(),
        reauthenticate
      }
    }
    const registry = new ProviderRegistry([base])
    const execution = { cwd: '/repo', fingerprint: 'sha256:test', targets: [], env: {} }
    const interaction = { openExternal: vi.fn(), prepareLoopbackCallback: vi.fn() }

    await expect(registry.reauthenticateMcp(
      { providerId: 'codex', cwd: '/repo' },
      'target-id',
      execution,
      interaction
    )).resolves.toMatchObject({ data: { ok: true, status: 'authenticated' } })
    expect(reauthenticate).toHaveBeenCalledWith(
      { providerId: 'codex', cwd: '/repo' },
      'target-id',
      execution,
      interaction
    )
  })

  it('uses the legacy full-access path when run controls are disabled', async () => {
    const base = adapter('codex')
    const run = vi.fn(base.run)
    base.run = run
    const registry = new ProviderRegistry([base], { runControlsEnabled: false })
    registry.run('codex', {
      runId: 'run-1',
      prompt: 'hi',
      attachments: [],
      model: { id: 'gpt-test' },
      effort: 'high',
      permissionMode: 'default',
      emit: vi.fn()
    })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      model: undefined,
      effort: undefined,
      permissionMode: 'full_access'
    }))
    await expect(registry.runControls({ providerId: 'codex' })).resolves.toMatchObject({
      state: 'degraded',
      data: { models: [], permissions: [expect.objectContaining({ id: 'full_access' })] }
    })
  })

  it('routes Hook trust inspection through the selected provider facet', async () => {
    const inspect = vi.fn().mockResolvedValue({
      cwd: '/repo',
      hooks: [],
      warnings: [],
      errors: []
    })
    const base: ProviderAdapter = {
      ...adapter('codex'),
      hookTrust: {
        inspect
      }
    }
    const registry = new ProviderRegistry([base])

    await expect(registry.inspectHookTrust({ providerId: 'codex', cwd: '/repo' })).resolves.toEqual({
      cwd: '/repo',
      hooks: [],
      warnings: [],
      errors: []
    })
    expect(inspect).toHaveBeenCalledWith({ providerId: 'codex', cwd: '/repo' })
  })

  it('keeps disabled providers visible but unavailable and blocks runs', async () => {
    const registry = new ProviderRegistry([adapter('codex')], { disabledProviders: new Set(['codex']) })
    await expect(registry.describe()).resolves.toEqual([
      expect.objectContaining({ id: 'codex', available: false, disabledReason: expect.stringContaining('SCRY_DISABLED_PROVIDERS') })
    ])
    expect(() => registry.run('codex', { runId: 'run-1', prompt: 'hi', attachments: [], emit: vi.fn() })).toThrow('provider disabled')
    await expect(registry.listCommands({ providerId: 'codex' })).resolves.toMatchObject({
      state: 'unsupported',
      reason: expect.stringContaining('SCRY_DISABLED_PROVIDERS')
    })
  })

  it('parses only known disabled provider ids', () => {
    expect([...parseDisabledProviders('codex, opencode,unknown')]).toEqual(['codex', 'opencode'])
  })
})
