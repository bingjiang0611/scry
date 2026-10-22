import { describe, expect, it } from 'vitest'
import { capabilityForRole, makePlanPreview, validateWorkflowProgram, workflowPlanningPrompt, workflowRevision } from './workflow-program'
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
  it('gives the real planner a complete, valid grammar example and rejects children', () => {
    const orchestrator = { ...role, role: 'orchestrator' as const }
    const prompt = workflowPlanningPrompt([orchestrator], 'Synthetic goal')
    const line = prompt.split('\n').find(line => line.startsWith('Grammar example: '))!
    const example = JSON.parse(line.slice('Grammar example: '.length))
    const candidate = { ...program, roles: [orchestrator], body: example.body }
    const validated = validateWorkflowProgram(candidate)
    expect(validated.body).toEqual(example.body)
    expect(JSON.stringify(example.body)).toContain('"kind":"parallel"')
    expect(JSON.stringify(example.body)).toContain('"inputRefs"')
    const { blocks, ...container } = example.body
    expect(() => validateWorkflowProgram({ ...candidate, body: { ...container, children: blocks } })).toThrow('children')
    expect(prompt).toContain('Goal:\nSynthetic goal')
  })

  it('parses only the explicit run command', () => {
    expect(parseWorkflowRunCommand('/scry-workflow run inspect the repo')).toEqual({ goal: 'inspect the repo' })
    expect(parseWorkflowRunCommand('/scry-workflow run')).toBeNull()
    expect(parseWorkflowRunCommand('/workflow run inspect')).toBeNull()
  })

  it('normalizes and freezes a declared structured output schema in the canonical program', () => {
    const candidate = { ...program, body: { ...program.body, blocks: [
      { ...program.body.blocks[0], outputSchema: { type: 'object', properties: { accepted: { type: 'boolean' } } } },
      program.body.blocks[1]
    ] } }
    const validated = validateWorkflowProgram(candidate)
    expect(validated.body).toMatchObject({ blocks: [{ outputSchema: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'] } }, {}] })
    const changed = validateWorkflowProgram({ ...candidate, body: { ...candidate.body, blocks: [
      { ...candidate.body.blocks[0], outputSchema: { type: 'string' } }, candidate.body.blocks[1]
    ] } })
    const { programRevision: _before, ...before } = validated
    const { programRevision: _after, ...after } = changed
    expect(workflowRevision(before)).not.toBe(workflowRevision(after))
    expect(JSON.stringify(candidate)).not.toContain('required')
    expect(workflowPlanningPrompt([role], 'structured inspection')).toContain('outputSchema')
  })

  it('rejects schema execution hooks while allowing data fields named command or path', () => {
    const schema = { type: 'object', properties: { command: { type: 'string' }, path: { type: 'string' } } }
    const withSchema = (outputSchema: unknown) => ({ ...program, body: { ...program.body, blocks: [
      { ...program.body.blocks[0], outputSchema }, program.body.blocks[1]
    ] } })
    expect(() => validateWorkflowProgram(withSchema(schema))).not.toThrow()
    expect(() => validateWorkflowProgram(withSchema({ ...schema, eval: 'process.exit(0)' }))).toThrow('eval')
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
