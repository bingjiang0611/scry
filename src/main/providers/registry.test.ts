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
