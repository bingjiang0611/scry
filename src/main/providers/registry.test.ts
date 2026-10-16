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
      forceKill: vi.fn(),
      forceKillScope: 'run_scoped' as const,
      getExternalSessionId: () => 'session-1'
    })
  }
}

describe('ProviderRegistry', () => {
  it('rejects duplicate provider ids', () => {
    expect(() => new ProviderRegistry([adapter('claude'), adapter('claude')])).toThrow('duplicate provider adapter')
  })

  it('rejects historical input before invoking an adapter without explicit support', () => {
    const base = adapter('codex')
    const run = vi.spyOn(base, 'run')
    const registry = new ProviderRegistry([base])
    expect(() => registry.run('codex', {
      runId: 'handoff', prompt: 'continue', attachments: [], emit: vi.fn(),
      historicalContext: { text: 'history', contentHash: 'not-used-before-capability-check' }
    })).toThrow('尚未提供可验证')
    expect(run).not.toHaveBeenCalled()
    registry.run('codex', { runId: 'ordinary', prompt: '/command', attachments: [], emit: vi.fn() })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each([{ trackInputReceipt: true as const }, { expectedInputTextHash: 'frozen-input' }])('rejects history-free input contracts without explicit adapter support: %j', (contract) => {
    const base = adapter('codex')
    const run = vi.spyOn(base, 'run')
    expect(() => new ProviderRegistry([base]).run('codex', {
      runId: 'first-input', prompt: 'hello', ...contract, attachments: [], emit: vi.fn()
    })).toThrow('尚未提供可验证')
    expect(run).not.toHaveBeenCalled()
  })

  it('stamps provider identity on emitted trace events', () => {
    const base = adapter('codex')
    base.run = (request) => {
      request.emit({ id: 'event-1', runId: request.runId, ts: '2026-07-10T00:00:00.000Z', kind: 'model', stage: 'text' })
      return {
        promise: Promise.resolve({}),
        interrupt: () => {},
        forceKill: () => {},
        forceKillScope: 'run_scoped' as const,
        getExternalSessionId: () => undefined
      }
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

  it('invalidates only the selected provider context', async () => {
    const invalidateContext = vi.fn()
    const claude = adapter('claude')
    claude.invalidateContext = invalidateContext
    const codex = adapter('codex')
    const registry = new ProviderRegistry([claude, codex])
    const context = { providerId: 'claude' as const, cwd: '/repo' }

    await registry.invalidateContext(context)

    expect(invalidateContext).toHaveBeenCalledOnce()
    expect(invalidateContext).toHaveBeenCalledWith(context)
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

  it('keeps provider-default permissions when run controls are disabled', async () => {
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
      permissionMode: 'default'
    }))
    await expect(registry.runControls({ providerId: 'codex' })).resolves.toMatchObject({
      state: 'degraded',
      data: { models: [], permissions: [expect.objectContaining({ id: 'default' })] }
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

  it('单个 adapter 描述失败只降为影子快照，不让整个列表消失', async () => {
    const broken: ProviderAdapter = {
      ...adapter('codex'),
      describe: async () => { throw new Error('codex home 不可读') }
    }
    const registry = new ProviderRegistry([adapter('claude'), broken])
    const descriptors = await registry.describe()
    expect(descriptors).toHaveLength(2)
    expect(descriptors.find((entry) => entry.id === 'claude')).toMatchObject({ available: true })
    expect(descriptors.find((entry) => entry.id === 'codex')).toMatchObject({
      id: 'codex',
      label: 'Codex',
      runtimeProvider: 'codex_cli',
      available: false,
      unavailableReason: 'Provider 描述失败：codex home 不可读',
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
      health: expect.objectContaining({ state: 'unavailable', lastError: expect.stringContaining('codex home 不可读') })
    })
    // 影子快照不得被读成「用户主动禁用」
    expect(descriptors.find((entry) => entry.id === 'codex')?.disabledReason).toBeUndefined()
  })

  it('把兼容性建议附在 descriptor 上，并传入实际版本', async () => {
    const versioned: ProviderAdapter = {
      ...adapter('codex'),
      describe: async () => ({
        id: 'codex' as const,
        label: 'Codex',
        runtimeProvider: 'codex_cli' as const,
        transport: 'test',
        available: true,
        version: 'codex-cli 0.160.1',
        capabilities: { skills: 'none' as const, mcp: 'none' as const, commands: 'none' as const, account: 'none' as const }
      })
    }
    const seen: Array<[string, string | undefined]> = []
    const registry = new ProviderRegistry([versioned], {
      compatibility: (providerId, version) => {
        seen.push([providerId, version])
        return {
          status: 'supported',
          observedVersion: '0.160.1',
          recommendedRange: '>=0.160.1',
          matchedRange: '>=0.160.1',
          reason: '已验证',
          source: 'bundled',
          manifestUpdatedAt: '2026-10-15T00:00:00.000Z'
        }
      }
    })
    const [descriptor] = await registry.describe()
    expect(seen).toEqual([['codex', 'codex-cli 0.160.1']])
    expect(descriptor.compatibility).toMatchObject({ status: 'supported', observedVersion: '0.160.1' })
    // 默认不配置时不凭空附加字段
    expect((await new ProviderRegistry([versioned]).describe())[0].compatibility).toBeUndefined()
  })
})
