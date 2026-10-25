import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type { WorkflowApproval, WorkflowBlock, WorkflowPlanPreview } from '../shared/workflow'
import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { FileWorkflowStore, MemoryWorkflowStore, type WorkflowStore } from './workflow-store'
import { WorkflowSystemHost } from './workflow-system-host'
import { WorkflowSlots } from './workflow-runner'
import { validateWorkflowProgram, workflowRevision, makePlanPreview } from './workflow-program'

export const call = (blockId: string, input?: string): Extract<WorkflowBlock, { kind: 'call' }> => ({ kind: 'call', blockId, role: 'worker', prompt: blockId, ...(input ? { inputRefs: [{ nodeId: input }] } : {}) })
export const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'parallel', blockId: 'siblings', blocks: [call('a'), call('b'), call('c')] }, call('d', 'b'), { kind: 'return', blockId: 'finish', ref: { nodeId: 'd' } }
] }
function descriptor(id: ProviderId): ProviderDescriptor {
  return { id, label: id, runtimeProvider: 'codex_cli', transport: 'fixture', available: true,
    capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }
}
export function revision(preview: WorkflowPlanPreview, edit: (body: WorkflowBlock) => void, roles = preview.program.roles): WorkflowPlanPreview {
  const candidate = structuredClone(preview.program)
  edit(candidate.body)
  candidate.roles = structuredClone(roles)
  const program = validateWorkflowProgram(candidate), { programRevision: _revision, ...snapshot } = program
  program.programRevision = workflowRevision(snapshot)
  return makePlanPreview(program, preview.roles, preview.orchestrator)
}
export const approval = (preview: WorkflowPlanPreview): WorkflowApproval => ({ workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 })
export const changedB = (preview: WorkflowPlanPreview) => revision(preview, root => {
  if (root.kind !== 'sequence' || root.blocks[0].kind !== 'parallel' || root.blocks[0].blocks[1].kind !== 'call') throw new Error('fixture shape')
  root.blocks[0].blocks[1].prompt = 'b-v2'
})
export async function fixture(file = false, withHost = true, serial = false, programBody: WorkflowBlock = body, providedStore?: WorkflowStore) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'scry-revision-'))), workspace = join(directory, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'input.txt'), 'baseline')
  const userData = join(directory, 'userData')
  const store: WorkflowStore = providedStore ?? (file ? new FileWorkflowStore(userData) : new MemoryWorkflowStore())
  const host = withHost ? new WorkflowSystemHost(join(directory, 'replicas'), store, () => ({})) : undefined
  const calls: Array<{ node: string; prompt: string }> = []
  const execute = vi.fn<WorkflowServiceOptions['execute']>(request => {
    const node = request.taskId.split(':').at(-1)!
    calls.push({ node, prompt: request.prompt })
    return { result: Promise.resolve({ runId: randomUUID(), status: 'completed', settled: true, actualModel: 'fixture-model', output: request.prompt + '-output' }), stop: () => true }
  })
  const makeService = (identity = 'fixture-runtime') => new WorkflowService({ store, systems: host, slots: new WorkflowSlots(serial ? 1 : 2), providerRegistered: () => true,
    runControls: async role => ({ descriptor: descriptor(role.providerId), identity, model: true, stop: true, independentRun: true, terminalOutput: true }),
    plan: async () => ({ output: JSON.stringify({ body: programBody }) }), execute })
  const service = makeService()
  const preview = await service.planCommand({ workspace, commandId: 'plan-' + randomUUID(), command: '/scry-workflow run inspect',
    orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [{ role: 'worker', providerId: 'codex', requestedModel: { providerId: 'openai', id: 'fixture-model' } }] })
  await service.approve(approval(preview))
  const start = () => service.start(preview.workflowId, approval(preview))
  const record = async () => (await store.load(preview.workflowId))!
  const revise = async (next: WorkflowPlanPreview, commandId = 'revise', controller = service) => controller.revise(next, approval(next), { expectedRevision: (await record()).progress.revision! }, commandId)
  const cleanup = async () => { service.close(); await rm(directory, { recursive: true, force: true }) }
  return { directory, workspace, userData, store, host, service, makeService, preview, calls, execute, record, start, revise, cleanup }
}
