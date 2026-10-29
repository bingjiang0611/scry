import { describe, expect, it, vi } from 'vitest'
import type { Query } from '@qoder-ai/qoder-agent-sdk'
import type { ProviderAdapter, ProviderRunRequest } from './types'
import { withQoderWorkflowAuthoring } from './qoder-workflow-authoring'

const adapter = (): ProviderAdapter => ({
  id: 'qoder',
  runtimeProvider: 'qoder_cli',
  describe: async () => ({ id: 'qoder', label: 'Qoder', runtimeProvider: 'qoder_cli', transport: 'fixture', available: true,
    capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' } }),
  run: vi.fn(() => { throw new Error('delegate') })
})

function request(extra: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    runId: 'run-authoring',
    purpose: 'workflow_authoring',
    prompt: 'Return the workflow JSON.',
    cwd: '/fixture',
    attachments: [],
    permissionMode: 'default',
    emit: vi.fn(),
    ...extra
  }
}

function queryResult(result: string) {
  const interrupt = vi.fn(async () => {})
  const q = {
    interrupt,
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'qoder-session' }
      yield { type: 'result', subtype: 'success', is_error: false, result, session_id: 'qoder-session' }
    }
  } as unknown as Query
  const run = vi.fn((_input: unknown) => q)
  return { run, interrupt }
}

describe('Qoder workflow authoring adapter', () => {
  it('uses a tool-free non-persistent query and returns immutable result JSON', async () => {
    const fixture = queryResult('{"schemaVersion":1,"roles":[],"body":{"kind":"sequence","blockId":"root","blocks":[]}}')
    const base = adapter()
    const wrapped = withQoderWorkflowAuthoring(base, { query: fixture.run as never })
    expect(wrapped.workflowAuthoring).toEqual({ source: 'qoder_cli_success_result', hostTools: 'disabled', permissionBoundary: 'default_only', businessQuestions: 'blocked' })
    const input = request()
    const result = await wrapped.run(input).promise
    expect(fixture.run).toHaveBeenCalledOnce()
    const call = fixture.run.mock.calls[0]?.[0] as { options: Record<string, unknown> }
    expect(call.options).toMatchObject({ tools: [], skills: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: false, permissionMode: 'default' })
    await expect((call.options.canUseTool as () => Promise<unknown>)()).resolves.toMatchObject({ behavior: 'deny', interrupt: true })
    expect(result).toMatchObject({ status: 'completed', externalSessionId: 'qoder-session',
      structuredOutput: { source: 'qoder_cli_success_result', json: expect.stringContaining('"schemaVersion":1') } })
    expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'model', stage: 'text' }))
    expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'harness', stage: 'result', isError: false }))
  })

  it('does not promote invalid model text to structured evidence', async () => {
    const fixture = queryResult('not json')
    const result = await withQoderWorkflowAuthoring(adapter(), { query: fixture.run as never }).run(request()).promise
    expect(result).toMatchObject({ status: 'completed' })
    expect(result).not.toHaveProperty('structuredOutput')
  })

  it('rejects unsafe authoring context and delegates ordinary runs', () => {
    const base = adapter()
    const wrapped = withQoderWorkflowAuthoring(base, { query: vi.fn() as never })
    expect(() => wrapped.run(request({ permissionMode: 'full_access' }))).toThrow()
    expect(() => wrapped.run(request({ purpose: undefined }))).toThrow('delegate')
    expect(base.run).toHaveBeenCalledOnce()
  })
})
