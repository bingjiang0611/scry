import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import type { WorkflowTemplateInstantiation } from '../shared/workflow-template'
import { FileWorkflowStore } from './workflow-store'
import { WorkflowTemplateStore } from './workflow-template-store'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { WorkflowSlots } from './workflow-runner'
import { WorkflowSystemHost } from './workflow-system-host'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const orchestrator = { role: 'orchestrator' as const, providerId: 'codex' as const }
const worker = { role: 'worker' as const, providerId: 'codex' as const }
function descriptor(id: ProviderId): ProviderDescriptor {
  return { id, label: id, runtimeProvider: 'codex_cli', transport: 'fixture', available: true,
    capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }
}
// A project-owned check: it fails until the fix call creates the marker. The argv
// is literal and project-specific, which is exactly why this cannot be a builtin.
const definition = (authorization?: unknown) => ({ schemaVersion: 1, name: 'Check and fix fixture', description: '',
  parameters: {}, roles: [{ role: 'worker', providerId: 'codex' }],
  body: { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'copy' },
    { kind: 'call', blockId: 'fix', role: 'worker', prompt: 'create the marker the check expects', inputRefs: [{ nodeId: 'copy' }] },
    { kind: 'check', blockId: 'verify', replica: { kind: 'ref', name: 'copy' },
      check: { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 10_000, parser: 'exit_code' },
      ...(authorization ? { authorization } : {}) },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'verify' } }
  ] } })

async function fixture(withAuthorization = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-check-template-'))); roots.push(root)
  const project = join(root, 'project'), userData = join(root, 'user')
  await Promise.all([mkdir(project), mkdir(userData)])
  await writeFile(join(project, 'check.cjs'), "process.exit(require('node:fs').existsSync('fixed.marker') ? 0 : 1)\n")
  const templates = new WorkflowTemplateStore(userData, cwd => { if (cwd !== project) throw new Error('unauthorized project'); return cwd }, join(root, 'locks'))
  const draft = await templates.saveDraft({ scope: { kind: 'project', workspace: project },
    source: JSON.stringify(definition(withAuthorization ? { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 10_000, parser: 'exit_code' } : undefined)) })
  const store = new FileWorkflowStore(userData)
  const plan = vi.fn(async () => { throw new Error('a template must not call the planning Agent') })
  const execute = vi.fn<WorkflowServiceOptions['execute']>(() => ({ result: Promise.resolve({ runId: 'fixture', status: 'completed' as const, settled: true }), stop: () => true }))
  const service = new WorkflowService({ store, templates, slots: new WorkflowSlots(2), plan, execute, providerRegistered: () => true,
    systems: new WorkflowSystemHost(join(root, 'replicas'), store),
    runControls: async input => ({ descriptor: descriptor(input.providerId), model: true, stop: true, identity: 'fixture-runtime', independentRun: true, terminalOutput: true }) })
  const request = (): WorkflowTemplateInstantiation => ({ source: { kind: 'draft', draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash },
    commandId: randomUUID(), cwd: project, userGoal: 'fix until the project check passes', parameters: {}, orchestrator, roles: [worker] })
  return { project, templates, service, plan, execute, request, validation: draft.validation }
}

describe('project check-and-fix templates', () => {
  it('accepts a project-specific literal check and freezes its authorization at preparation', async () => {
    const f = await fixture()
    expect(f.validation).toEqual({ state: 'valid' })
    const preview = await f.service.instantiateTemplate(f.request())
    expect(preview.state).toBe('ready')
    const body = preview.program.body
    if (body.kind !== 'sequence') throw new Error('fixture root')
    const check = body.blocks.find(block => block.kind === 'check')
    if (!check || check.kind !== 'check') throw new Error('fixture check')
    expect(check.check.argv).toEqual([process.execPath, 'check.cjs'])
    // Main, not the template, attached the grant; it names the real workspace.
    expect(check.authorization).toMatchObject({ replicaRoot: f.project, argv: [process.execPath, 'check.cjs'], parser: 'exit_code' })
    expect(check.authorization?.executableHash).toMatch(/^[a-f0-9]{64}$/)
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('rejects a template that ships its own check authorization', async () => {
    const f = await fixture(true)
    expect(f.validation.state).toBe('invalid')
    await expect(f.service.instantiateTemplate(f.request())).rejects.toThrow()
    expect(f.plan).not.toHaveBeenCalled()
  })
})
