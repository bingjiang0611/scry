import { describe, expect, it, vi } from 'vitest'
import type { ProviderAdapter } from './types'
import { selectProviderTransports } from './legacy-cli'

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: (providerId: string) => `/bin/${providerId}`,
  runtimeCliEnv: () => ({}),
  shellEnv: () => ({})
}))

const native = (id: ProviderAdapter['id']): ProviderAdapter => ({
  id,
  runtimeProvider: id === 'codex' ? 'codex_cli' : id === 'qoder' ? 'qoder_cli' : id === 'opencode' ? 'opencode_server' : 'claude_sdk',
  describe: async () => ({
    id,
    label: id,
    runtimeProvider: id === 'codex' ? 'codex_cli' : id === 'qoder' ? 'qoder_cli' : id === 'opencode' ? 'opencode_server' : 'claude_sdk',
    transport: 'native',
    available: true,
    capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }
  }),
  run: vi.fn() as never
})

describe('provider transport selection', () => {
  it('uses legacy only for explicit codex/qoder overrides', async () => {
    const adapters = selectProviderTransports([native('claude'), native('codex'), native('qoder')], 'codex:legacy,qoder:native')
    await expect(adapters[0].describe()).resolves.toMatchObject({ transport: 'native' })
    await expect(adapters[1].describe()).resolves.toMatchObject({ transport: 'legacy-cli-jsonl', capabilities: { skills: 'none' } })
    await expect(adapters[2].describe()).resolves.toMatchObject({ transport: 'native' })
  })

  it('does not silently select unsupported legacy transports', () => {
    const warn = vi.fn()
    const adapter = selectProviderTransports([native('opencode')], 'opencode:legacy', warn)[0]
    expect(adapter.id).toBe('opencode')
    expect(warn).toHaveBeenCalledOnce()
  })
})
