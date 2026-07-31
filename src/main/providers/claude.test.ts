import { beforeEach, describe, expect, it, vi } from 'vitest'

const runner = vi.hoisted(() => ({ captureInit: vi.fn(), runAgent: vi.fn() }))
const mcp = vi.hoisted(() => ({ testMcpConfig: vi.fn() }))
const sdk = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))
vi.mock('../agent-runner', () => ({ captureInit: runner.captureInit, getClaudeVersion: () => 'test', runAgent: runner.runAgent }))
vi.mock('../claude-locate', () => ({
  resolveClaudeBin: () => '/bin/claude',
  runtimeCliEnv: () => ({
    PATH: '/runtime/bin',
    ANTHROPIC_API_KEY: 'provider-auth',
    UNAPPROVED_SECRET: 'runtime-secret',
    HTTPS_PROXY: 'http://provider-user:provider-secret@proxy.example.test',
    SSL_CERT_FILE: '/runtime/provider-ca.pem'
  })
}))
vi.mock('../mcp-config', async () => {
  const actual = await vi.importActual<typeof import('../mcp-config')>('../mcp-config')
  return {
    ...actual,
    findMcpConfigByTargetId: () => ({ config: { command: '/bin/mcp' } }),
    listMcp: () => [{ targetId: 'target-scry-e2e', name: 'scry-e2e', scope: '.mcp.json', transport: 'stdio', detail: '/bin/mcp', enabled: true }],
    testMcpConfig: mcp.testMcpConfig,
    toggleMcp: vi.fn()
  }
})
vi.mock('../skill-config', () => ({
  computeEnabledSkills: () => ['scry-e2e-audit'],
  listSkills: () => [{ name: 'scry-e2e-audit', dir: 'scry-e2e-audit', scope: 'project', description: 'Safe audit', enabled: true }],
  setSkillEnabled: vi.fn()
}))

import { createClaudeAdapter } from './claude'

describe('Claude provider adapter', () => {
  beforeEach(() => {
    runner.captureInit.mockReset()
    runner.runAgent.mockReset()
    mcp.testMcpConfig.mockReset()
    sdk.query.mockReset()
    delete process.env.SCRY_CLAUDE_SETTING_SOURCES
  })

  it('keeps Claude capabilities explicit', async () => {
    await expect(createClaudeAdapter('/tmp/scry-home').describe()).resolves.toMatchObject({
      id: 'claude',
      runtimeProvider: 'claude_sdk',
      capabilities: { skills: 'manage', mcp: 'manage', commands: 'read', account: 'none' }
    })
  })

  it('lists statically discovered Skill commands without launching a hidden model probe', async () => {
    const result = await createClaudeAdapter('/tmp/scry-home').commands!.list({ providerId: 'claude', cwd: '/repo' })
    expect(result).toMatchObject({
      state: 'degraded',
      data: [{ name: 'scry-e2e-audit', source: 'skill' }]
    })
    expect(runner.captureInit).not.toHaveBeenCalled()
  })

  it('refreshes MCP status with a direct protocol test instead of a model probe', async () => {
    mcp.testMcpConfig.mockResolvedValue({ ok: true, tools: 3 })
    const result = await createClaudeAdapter('/tmp/scry-home').mcp!.snapshot(
      { providerId: 'claude', cwd: '/repo' },
      true,
      {
        cwd: '/repo',
        env: {},
        targets: [{ targetId: 'target-scry-e2e', name: 'scry-e2e', enabled: true, config: { command: '/bin/mcp' } }]
      }
    )
    expect(result).toMatchObject({
      state: 'ready',
      data: { runtime: [{ name: 'scry-e2e', status: 'connected', tools: 3 }] }
    })
    expect(runner.captureInit).not.toHaveBeenCalled()
  })

  it('forwards an explicit setting-source allowlist without changing the default', async () => {
    process.env.SCRY_CLAUDE_SETTING_SOURCES = 'project,local'
    runner.runAgent.mockReturnValue({
      promise: Promise.resolve({}),
      interrupt: vi.fn(),
      getSessionId: vi.fn()
    })

    createClaudeAdapter('/tmp/scry-home').run({
      runId: 'run-1',
      prompt: 'probe',
      cwd: '/repo',
      attachments: [],
      model: { id: 'claude-test' },
      effort: 'high',
      permissionMode: 'default',
      emit: vi.fn()
    })

    expect(runner.runAgent).toHaveBeenCalledWith(
      'probe',
      'run-1',
      expect.any(Function),
      expect.objectContaining({
        settingSources: ['project', 'local'],
        env: {
          PATH: '/runtime/bin',
          ANTHROPIC_API_KEY: 'provider-auth',
          UNAPPROVED_SECRET: 'runtime-secret',
          HTTPS_PROXY: 'http://provider-user:provider-secret@proxy.example.test',
          SSL_CERT_FILE: '/runtime/provider-ca.pem',
          CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
        },
        model: 'claude-test',
        effort: 'high',
        permissionMode: 'default'
      })
    )
  })

  it('runs authorized MCP servers with the exact approved inherited environment', () => {
    runner.runAgent.mockReturnValue({
      promise: Promise.resolve({}),
      interrupt: vi.fn(),
      getSessionId: vi.fn()
    })

    createClaudeAdapter('/tmp/scry-home').run({
      runId: 'run-env',
      prompt: 'probe',
      cwd: '/repo',
      attachments: [],
      emit: vi.fn(),
      mcpExecution: {
        cwd: '/repo',
        env: {
          PATH: '/approved/bin',
          HTTPS_PROXY: 'http://proxy.example.test',
          LANG: 'approved',
          CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
        },
        targets: [
          {
            targetId: 'target',
            name: 'tracker',
            enabled: true,
            config: { command: '/bin/tracker', env: { LANG: 'configured' } }
          },
          {
            targetId: 'http-target',
            name: 'remote',
            enabled: true,
            config: { type: 'http', url: 'https://mcp.example.test' }
          }
        ]
      }
    })

    expect(runner.runAgent).toHaveBeenCalledWith(
      'probe',
      'run-env',
      expect.any(Function),
      expect.objectContaining({
        env: {
          ANTHROPIC_API_KEY: 'provider-auth',
          UNAPPROVED_SECRET: 'runtime-secret',
          PATH: '/approved/bin',
          HTTPS_PROXY: 'http://proxy.example.test',
          LANG: 'approved',
          CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
        },
        mcpServers: {
          tracker: {
            command: '/bin/tracker',
            env: {
              PATH: '/approved/bin',
              HTTPS_PROXY: 'http://proxy.example.test',
              LANG: 'configured',
              CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
            }
          },
          remote: { type: 'http', url: 'https://mcp.example.test' }
        }
      })
    )
    expect(runner.runAgent.mock.calls.at(-1)?.[3].mcpServers.tracker.env).not.toHaveProperty('UNAPPROVED_SECRET')
    expect(runner.runAgent.mock.calls.at(-1)?.[3].mcpServers.remote).not.toHaveProperty('env')
  })

  it('keeps provider proxy and CA for stdio-only MCP while the child receives only the approved snapshot', () => {
    runner.runAgent.mockReturnValue({
      promise: Promise.resolve({}),
      interrupt: vi.fn(),
      getSessionId: vi.fn()
    })
    createClaudeAdapter('/tmp/scry-home').run({
      runId: 'run-stdio',
      prompt: 'probe',
      cwd: '/repo',
      attachments: [],
      emit: vi.fn(),
      mcpExecution: {
        cwd: '/repo',
        env: { PATH: '/approved/bin', TERM: 'approved-term', CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1' },
        targets: [{ targetId: 'stdio', name: 'stdio', enabled: true, config: { command: '/bin/stdio' } }]
      }
    })
    const options = runner.runAgent.mock.calls.at(-1)?.[3]
    expect(options.env).toMatchObject({
      HTTPS_PROXY: 'http://provider-user:provider-secret@proxy.example.test',
      SSL_CERT_FILE: '/runtime/provider-ca.pem',
      ANTHROPIC_API_KEY: 'provider-auth'
    })
    expect(options.mcpServers.stdio.env).toEqual({
      PATH: '/approved/bin',
      TERM: 'approved-term',
      CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
    })
    expect(options.mcpServers.stdio.env).not.toHaveProperty('HTTPS_PROXY')
    expect(options.mcpServers.stdio.env).not.toHaveProperty('ANTHROPIC_API_KEY')
  })

  it('reads model and effort options from the native control catalog', async () => {
    sdk.query.mockReturnValue({
      supportedModels: vi.fn().mockResolvedValue([{
        value: 'claude-test',
        displayName: 'Claude Test',
        description: 'test model',
        supportedEffortLevels: ['low', 'high']
      }]),
      close: vi.fn()
    })
    const result = await createClaudeAdapter('/tmp/scry-home').runControls!.read({
      providerId: 'claude',
      cwd: '/repo'
    })
    expect(result).toMatchObject({
      state: 'ready',
      data: {
        models: [{
          model: { id: 'claude-test' },
          label: 'Claude Test',
          efforts: [{ id: 'low' }, { id: 'high' }]
        }],
        permissions: [
          { id: 'default' },
          { id: 'auto_review' },
          { id: 'full_access' }
        ]
      }
    })
  })
})
