import { describe, expect, it, vi } from 'vitest'
import type { ProviderAdapter } from './types'
import { selectProviderTransports } from './legacy-cli'

const cli = vi.hoisted(() => ({
  assertRuntimeCliSurface: vi.fn(),
  runCliAgent: vi.fn(() => ({
    promise: Promise.resolve({ sessionId: 'legacy-session', stopped: false }),
    interrupt: vi.fn(),
    getSessionId: () => 'legacy-session'
  }))
}))

vi.mock('../cli-runtime', () => cli)

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

  it('forwards explicit permissions and isolates Qoder from native MCP config', async () => {
    const adapter = selectProviderTransports([native('qoder')], 'qoder:legacy')[0]
    await expect(adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })).resolves.toMatchObject({
      data: { permissions: expect.arrayContaining([expect.objectContaining({ id: 'full_access' })]) }
    })
    await adapter.run({
      runId: 'run-legacy',
      prompt: 'hello',
      cwd: '/repo',
      attachments: [],
      permissionMode: 'auto_review',
      emit: vi.fn()
    }).promise
    expect(cli.runCliAgent).toHaveBeenCalledWith(
      'hello',
      'run-legacy',
      expect.any(Function),
      expect.objectContaining({
        permissionMode: 'auto_review',
        mcpConfigPath: '{"mcpServers":{}}'
      })
    )
  })

  it('keeps native Codex Hook inspection and forwards only the resulting bypass grant', () => {
    const inspect = vi.fn()
    const codex: ProviderAdapter = { ...native('codex'), hookTrust: { inspect } }
    const adapter = selectProviderTransports([codex], 'codex:legacy')[0]
    expect(adapter.hookTrust?.inspect).toBe(inspect)

    adapter.run({
      runId: 'run-codex-legacy',
      prompt: 'hello',
      attachments: [],
      permissionMode: 'default',
      bypassHookTrust: true,
      emit: vi.fn()
    })
    expect(cli.runCliAgent).toHaveBeenLastCalledWith(
      'hello',
      'run-codex-legacy',
      expect.any(Function),
      expect.objectContaining({ bypassHookTrust: true })
    )
  })

  it('does not advertise or silently approximate auto_review on legacy Codex', async () => {
    const adapter = selectProviderTransports([native('codex')], 'codex:legacy')[0]
    const controls = await adapter.runControls!.read({ providerId: 'codex', cwd: '/repo' })
    expect(controls.data?.permissions.map((permission) => permission.id)).toEqual(['default', 'full_access'])
    expect(() => adapter.run({
      runId: 'run-auto',
      prompt: 'hello',
      attachments: [],
      permissionMode: 'auto_review',
      emit: vi.fn()
    })).toThrow('不支持 auto_review')
  })

  it('fails closed instead of silently starting a new session for legacy resume', () => {
    const adapter = selectProviderTransports([native('qoder')], 'qoder:legacy')[0]
    expect(() => adapter.run({
      runId: 'run-resume',
      prompt: 'follow-up',
      resume: 'existing-session',
      attachments: [],
      emit: vi.fn()
    })).toThrow('不支持恢复已有会话')
  })
})
