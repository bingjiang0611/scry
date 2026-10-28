import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, vi } from 'vitest'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { MemoryWorkflowStore, type WorkflowStore } from './workflow-store'
import { WorkflowSystemHost } from './workflow-system-host'
import type { WorkflowControlFrame } from '../shared/workflow'
import { WorkflowSlots } from './workflow-runner'

export const roots: string[] = []
const services = new Set<WorkflowService>(), work = new Set<Promise<unknown>>()
function track<T>(result: Promise<T>): Promise<T> {
  const pending = result.finally(() => work.delete(pending))
  work.add(pending)
  return pending
}
afterEach(async () => {
  if (work.size) {
    // A timed-out assertion does not cancel its asynchronous workflow. Freeze
    // further admission and converge owned execution before removing its files.
    await Promise.all([...services].map(service => service.prepareForShutdown()))
    await Promise.allSettled([...work])
  }
  for (const service of services) service.close()
  services.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
export class CutParentStore extends MemoryWorkflowStore {
  cut = false
  override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, expected: number) {
    if (this.cut && frame.nodeId === 'root' && frame.cursor === 2) throw new Error('fixture system parent checkpoint failure')
    return super.saveFrame(frame, expected)
  }
}
export async function fixture(code = 0, store: WorkflowStore = new CutParentStore(), agent: false | 'copy' | 'forged' = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-system-runner-')))
  roots.push(root)
  const source = join(root, 'source'), directory = join(root, 'copies')
  await mkdir(source)
  await writeFile(join(source, 'check.cjs'), `const fs = require('node:fs'); const path = 'native-count'; let n = 0; try { n = Number(fs.readFileSync(path, 'utf8')) } catch (e) { if(e.code !== 'ENOENT') throw e } fs.writeFileSync(path, String(n + 1)); console.log('observed'); process.exitCode = ${code}`)
  const body = agent ? { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'copy' },
    { kind: 'call', blockId: 'work', role: 'orchestrator', prompt: 'modify copy', replica: agent === 'copy' ? { kind: 'ref', name: 'copy' }
      : { kind: 'literal', value: { workflowId: 'forged', replicaId: 'forged', inputHash: 'a'.repeat(64) } } },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'work' } }
  ] } : { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'copy' },
    { kind: 'check', blockId: 'verify', replica: { kind: 'ref', name: 'copy' }, check: { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 2000, parser: 'exit_code' } },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'verify', path: ['passed'] } }
  ] }
  const role = { role: 'orchestrator' as const, providerId: 'claude' as const }
  const execute = vi.fn<WorkflowServiceOptions['execute']>()
  const env = { HOME: root, PATH: '/usr/bin:/bin' }
  const create = (currentStore = store, currentBody: unknown = body) => {
    const host = new WorkflowSystemHost(directory, currentStore, () => env), slots = new WorkflowSlots(1)
    const service = new WorkflowService({ store: currentStore, slots, systems: host, execute, plan: async () => ({ output: JSON.stringify({ body: currentBody }) }), providerRegistered: () => true,
      runControls: async () => ({ descriptor: { id: 'claude', label: 'fixture', runtimeProvider: 'claude_sdk', transport: 'fixture', available: true, capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }, identity: 'fixture', model: true, stop: true, independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const }) })
    services.add(service)
    const start = service.start.bind(service), revise = service.revise.bind(service)
    service.start = (...args) => track(start(...args))
    service.revise = (...args) => track(revise(...args))
    return { service, host, slots }
  }
  const instance = create(), preview = await instance.service.planCommand({ command: '/scry-workflow run check', workspace: source, orchestrator: role, roles: [] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await instance.service.approve(approval)
  return { ...instance, create, preview, approval, store, root, source, execute }
}
