import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type { WorkflowBlock, WorkflowPlanPreview } from '../../src/shared/workflow'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from '../../src/main/workflow-program'
import { WorkflowService } from '../../src/main/workflow-service'
import type { WorkflowProviderExecutor } from '../../src/main/workflow-runner-contracts'
import { WorkflowSystemHost } from '../../src/main/workflow-system-host'
import { WorkflowSlots } from '../../src/main/workflow-slots'
import type { FileWorkflowStore } from '../../src/main/workflow-store'

const independent = { kind: 'call', blockId: 'independent', role: 'worker', prompt: 'independent' } as const
const initial: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
  independent,
  { kind: 'return', blockId: 'report', ref: { nodeId: 'independent' } }
] }
const revised: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
  independent,
  { kind: 'replica', blockId: 'candidate' },
  { kind: 'check', blockId: 'check', replica: { kind: 'ref', name: 'candidate' }, check: { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 2000, parser: 'exit_code' } },
  { kind: 'branch', blockId: 'gate', when: { kind: 'literal', value: true },
    then: { kind: 'sequence', blockId: 'terminal-parent', blocks: [
      { kind: 'call', blockId: 'scoped', role: 'worker', prompt: 'scoped', replica: { kind: 'ref', name: 'candidate' }, inputRefs: [{ nodeId: 'check', path: ['passed'] }] }
    ] },
    else: { kind: 'bind', blockId: 'unused', value: { kind: 'literal', value: 'unused' } }, unknown: 'blocked' },
  { kind: 'return', blockId: 'report', ref: { nodeId: 'gate' } }
] }

/** Test-only local CLI transport; the actual compiler/Service/Runner/Interpreter,
 * FileStore, owned-copy authority and native check implementation are unchanged. */
export async function runNativeRevision(root: string, mode: 'native-revision-crash' | 'native-revision-resume', store: FileWorkflowStore,
  execute: WorkflowProviderExecutor, registerCleanup: (cleanup: () => Promise<boolean>) => void) {
  const workspace = await realpath(join(root, 'workspace'))
  if (process.platform === 'darwin') {
    await new Promise<void>((resolve, reject) => {
      const server = createServer()
      server.once('error', (error: NodeJS.ErrnoException) => error.code === 'EPERM' ? resolve() : reject(error))
      server.listen(0, '127.0.0.1', () => server.close(() => reject(new Error('controller network unexpectedly allowed'))))
    })
    await writeFile(join(root, 'controller-network-proof.json'), JSON.stringify({ pid: process.pid, network: 'EPERM' }))
  }
  const host = new WorkflowSystemHost(join(root, 'replicas'), store, () => ({ HOME: root, PATH: '/usr/bin:/bin' }))
  const service = new WorkflowService({ store, systems: host, slots: new WorkflowSlots(1), execute: request => execute({ ...request, cwd: request.workspace }), providerRegistered: () => true,
    plan: async () => ({ output: JSON.stringify({ body: initial }) }),
    runControls: async () => ({ descriptor: { id: 'claude', label: 'local CLI fixture', runtimeProvider: 'claude_sdk', transport: 'fixture', available: true,
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } },
      identity: 'fixture', model: true, stop: true, independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'available', hostToolsDisabled: 'available' }) })
  registerCleanup(async () => (await service.prepareForShutdown()).state === 'ready')
  try {
    if (mode === 'native-revision-resume') {
      const preview: WorkflowPlanPreview = JSON.parse(await readFile(join(root, 'preview.json'), 'utf8'))
      const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
      await service.approve(approval)
      return await service.resume(preview.workflowId, approval, 'native-cold-continue')
    }
    const first = await service.planCommand({ workspace, commandId: 'native-plan', command: '/scry-workflow run temporary native recovery',
      orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [{ role: 'worker', providerId: 'claude' }] })
    const approval = { workflowId: first.workflowId, programRevision: first.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const started = await service.start(first.workflowId, approval)
    if (started.state !== 'completed') throw new Error('initial local CLI root did not complete')
    const program = await host.prepare(validateWorkflowProgram({ ...first.program, programRevision: 'pending', body: revised }))
    const { programRevision: _revision, ...snapshot } = program
    program.programRevision = workflowRevision(snapshot)
    const preview = makePlanPreview(program, first.roles, first.orchestrator)
    await writeFile(join(root, 'preview.json'), JSON.stringify(preview), { flush: true })
    const current = (await store.load(first.workflowId))!
    return await service.revise(preview, { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 },
      { expectedRevision: current.progress.revision! }, 'native-revision')
  } finally { service.close() }
}
