import { describe, expect, it, vi } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { RunOpts } from './agent-runner'
import { createAgentOptions, type AgentOptionContext } from './agent-runner-options'
import { workflowAuthoringCopy } from '../shared/constants/copy'

const schema = { type: 'object', required: ['body'], properties: { body: { type: 'object' } }, additionalProperties: false }
const context = (permissionMode: AgentOptionContext['permissionMode'] = 'default'): AgentOptionContext => ({
  runId: 'authoring-fixture', permissionMode,
  onUserPromptSubmit: vi.fn(), onStderr: vi.fn(), onSpawnedProcess: vi.fn()
})

describe('native Claude structured authoring options', () => {
  it('removes inherited tools and configuration, freezes the schema and never asks for host permission', async () => {
    const requestUserInput = vi.fn<NonNullable<RunOpts['requestUserInput']>>()
    const inputSchema = structuredClone(schema)
    const options = createAgentOptions({ authoringSchema: inputSchema, settingSources: ['user', 'project'],
      skills: ['untrusted-skill'], captureProviderTurnId: true, requestUserInput,
      mcpServers: { untrusted: { command: '/bin/sh', args: ['-c', 'false'] } } }, context())
    expect(options).toMatchObject({ tools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true,
      plugins: [], skills: [], hooks: {}, maxTurns: 1,
      settings: { disableAllHooks: true, autoMemoryEnabled: false, autoDreamEnabled: false },
      outputFormat: { type: 'json_schema', schema } })
    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions')
    expect(options).not.toHaveProperty('extraArgs')
    inputSchema.required.push('later-mutation')
    expect(options.outputFormat).toEqual({ type: 'json_schema', schema })
    const canUseTool = options.canUseTool as NonNullable<Options['canUseTool']>
    await expect(canUseTool('Bash', { command: 'synthetic-host-effect' }, { signal: new AbortController().signal, toolUseID: 'host-probe', requestId: 'permission-probe' }))
      .resolves.toEqual({ behavior: 'deny', message: workflowAuthoringCopy.hostToolsDisabled, interrupt: true })
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it.each<AgentOptionContext['permissionMode']>(['full_access', 'auto_review', 'auto_accept_edits'])('rejects %s instead of silently changing the declared permission', permissionMode => {
    expect(() => createAgentOptions({ authoringSchema: schema }, context(permissionMode))).toThrow(workflowAuthoringCopy.invalidContext)
  })

  it('rejects resumed native context before creating a query', () => {
    expect(() => createAgentOptions({ authoringSchema: schema, resume: 'previous-private-session' }, context())).toThrow(workflowAuthoringCopy.invalidContext)
  })
})
