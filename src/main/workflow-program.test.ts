import { describe, expect, it } from 'vitest'
import { capabilityForRole, makePlanPreview, validateWorkflowProgram } from './workflow-program'
import { WORKFLOW_SCHEMA_VERSION, parseWorkflowRunCommand } from '../shared/workflow'

const role = { role: 'worker' as const, providerId: 'codex' as const, requestedModel: { id: 'fixture-model' } }
const program = {
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  workflowId: 'workflow-test',
  programRevision: 'revision-test',
  userGoal: 'inspect the workspace',
  workspace: '/tmp/workspace',
  roles: [role],
  body: { kind: 'sequence' as const, blockId: 'root', blocks: [
    { kind: 'call' as const, blockId: 'call-1', role: 'worker' as const, prompt: 'Inspect only' },
    { kind: 'return' as const, blockId: 'return-1', ref: { nodeId: 'call-1' } }
  ] }
}

describe('WorkflowProgram M0 contract', () => {
  it('parses only the explicit run command', () => {
    expect(parseWorkflowRunCommand('/scry-workflow run inspect the repo')).toEqual({ goal: 'inspect the repo' })
    expect(parseWorkflowRunCommand('/scry-workflow run')).toBeNull()
    expect(parseWorkflowRunCommand('/workflow run inspect')).toBeNull()
  })

  it('rejects unsupported control blocks and duplicate ids', () => {
    expect(() => validateWorkflowProgram({ ...program, body: { kind: 'loop', blockId: 'loop' } })).toThrow('仅支持')
    expect(() => validateWorkflowProgram({ ...program, body: { ...program.body, blocks: [program.body.blocks[0], { ...program.body.blocks[0] }] } })).toThrow('重复')
  })

  it('reports unavailable capability instead of silently selecting another provider', () => {
    const capability = capabilityForRole(role, {
      adapterRegistered: true,
      hasIndependentRun: true,
      canObserveOutput: true,
      canConfirmStop: false,
      descriptor: { id: 'codex', label: 'Codex', runtimeProvider: 'codex_cli', transport: 'fixture', available: true,
        capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }
    })
    expect(capability.state).toBe('unavailable')
    expect(capability.providerId).toBe('codex')
  })

  it('freezes the selected program in the preview', () => {
    const preview = makePlanPreview(program, [{
      role: 'worker', providerId: 'codex', requestedModel: { id: 'fixture-model' }, actualModelStatus: 'unknown',
      startIndependentSession: 'available', observeTerminalOutput: 'available', confirmStopConvergence: 'available', state: 'available'
    }], role)
    expect(preview.state).toBe('ready')
    expect(preview.program.programRevision).toBe('revision-test')
  })
})
