import { beforeEach, describe, expect, it, vi } from 'vitest'

const runner = vi.hoisted(() => ({ captureInit: vi.fn(), runAgent: vi.fn() }))
const mcp = vi.hoisted(() => ({ testMcpConfig: vi.fn() }))
vi.mock('../agent-runner', () => ({ captureInit: runner.captureInit, getClaudeVersion: () => 'test', runAgent: runner.runAgent }))
vi.mock('../claude-locate', () => ({ resolveClaudeBin: () => '/bin/claude', shellEnv: () => ({}) }))
vi.mock('../mcp-config', () => ({
  findMcpConfig: () => ({ command: '/bin/mcp' }),
  listMcp: () => [{ name: 'scry-e2e', scope: '.mcp.json', transport: 'stdio', detail: '/bin/mcp', enabled: true }],
  testMcpConfig: mcp.testMcpConfig,
  toggleMcp: vi.fn()
}))
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
    const result = await createClaudeAdapter('/tmp/scry-home').mcp!.snapshot({ providerId: 'claude', cwd: '/repo' }, true)
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
      emit: vi.fn()
    })

    expect(runner.runAgent).toHaveBeenCalledWith(
      'probe',
      'run-1',
      expect.any(Function),
      expect.objectContaining({ settingSources: ['project', 'local'] })
    )
  })
})
