import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClaudeAdapter } from './claude'
import { createAgentOptions } from '../agent-runner-options'
import type { RunOpts } from '../agent-runner'
import { workflowAuthoringSchema } from '../workflow-authoring'

const runner = vi.hoisted(() => vi.fn())
const skills = vi.hoisted(() => vi.fn(() => ['configured-skill']))
vi.mock('../agent-runner', () => ({ runAgent: runner, getClaudeVersion: () => undefined }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn(), forkSession: vi.fn(), getSessionMessages: vi.fn() }))
vi.mock('../claude-locate', () => ({ resolveClaudeBin: () => '/offline/claude', runtimeCliEnv: () => ({ PATH: '/offline/bin' }) }))
vi.mock('../skill-config', () => ({ computeEnabledSkills: skills }))

beforeEach(() => { runner.mockReset(); skills.mockClear() })
function request() {
  return { runId: 'canonical-adapter-result', prompt: 'author', cwd: '/offline/workspace', attachments: [], emit: vi.fn() }
}

describe('Claude canonical result projection', () => {
  it('forwards SDK result provenance without parsing assistant text or running another query', async () => {
    const structuredOutput = { source: 'claude_sdk_success_result' as const, json: '{"decision":"workflow"}' }
    runner.mockReturnValue({ promise: Promise.resolve({ sessionId: 'canonical-session', status: 'completed', structuredOutput }),
      interrupt: vi.fn(), forceKill: vi.fn(), getSessionId: () => 'canonical-session' })
    const result = await createClaudeAdapter('/offline/home').run({ ...request(), purpose: 'workflow_authoring' }).promise
    expect(result).toMatchObject({ externalSessionId: 'canonical-session', status: 'completed', structuredOutput })
    expect(runner).toHaveBeenCalledOnce()
  })

  it('preserves unavailable structured evidence instead of inventing an empty candidate', async () => {
    runner.mockReturnValue({ promise: Promise.resolve({ status: 'completed' }), interrupt: vi.fn(), getSessionId: vi.fn() })
    const result = await createClaudeAdapter('/offline/home').run(request()).promise
    expect(result.status).toBe('completed')
    expect(result).not.toHaveProperty('structuredOutput')
    expect(runner).toHaveBeenCalledOnce()
    expect(runner.mock.calls[0][3]).not.toHaveProperty('authoringSchema')
    expect(skills).toHaveBeenCalledOnce()
  })

  it('uses a Main-selected purpose-specific authoring schema without exposing a second transport path', async () => {
    runner.mockReturnValue({ promise: Promise.resolve({ status: 'completed' }), interrupt: vi.fn(), getSessionId: vi.fn() })
    const schema = { type: 'object', required: ['source'], properties: { source: { type: 'string' } }, additionalProperties: false } as const
    await createClaudeAdapter('/offline/home').run({ ...request(), purpose: 'workflow_authoring', authoringSchema: schema }).promise
    const opts = runner.mock.calls[0][3] as RunOpts
    expect(opts.authoringSchema).toEqual(schema)
    expect(runner).toHaveBeenCalledOnce()
  })

  it('passes the private purpose through the actual adapter and restricted option builder without native execution', async () => {
    runner.mockReturnValue({ promise: Promise.resolve({ status: 'completed' }), interrupt: vi.fn(), getSessionId: vi.fn() })
    const adapter = createClaudeAdapter('/offline/home')
    expect(adapter.workflowAuthoring).toEqual({ source: 'claude_sdk_success_result' })
    await adapter.run({ ...request(), purpose: 'workflow_authoring' }).promise
    expect(skills).not.toHaveBeenCalled()
    const opts = runner.mock.calls[0][3] as RunOpts
    expect(opts.authoringSchema).toEqual(workflowAuthoringSchema)
    const options = createAgentOptions(opts, { runId: request().runId, permissionMode: 'default',
      onUserPromptSubmit: vi.fn(), onStderr: vi.fn(), onSpawnedProcess: vi.fn() })
    expect(options).toMatchObject({ tools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true,
      hooks: {}, plugins: [], skills: [], maxTurns: 1,
      settings: { disableAllHooks: true, autoMemoryEnabled: false, autoDreamEnabled: false },
      outputFormat: { type: 'json_schema', schema: workflowAuthoringSchema } })
    expect(runner).toHaveBeenCalledOnce()
  })
})
