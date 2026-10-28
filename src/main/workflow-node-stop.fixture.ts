import { vi } from 'vitest'
import { MemoryWorkflowStore, type WorkflowStore } from './workflow-store'
import { WorkflowService, type WorkflowProviderExecutionResult, type WorkflowServiceOptions } from './workflow-service'
import { WorkflowSlots } from './workflow-slots'
import type { ProviderDescriptor } from '../shared/provider'
import type { WorkflowBlock } from '../shared/workflow'

const role = { role: 'worker' as const, providerId: 'pi' as const, agentProfileId: 'pi:default', requestedModel: { providerId: 'openai', id: 'fixture' } }
const orchestrator = { role: 'orchestrator' as const, providerId: 'codex' as const }
const planOutput = JSON.stringify({ body: { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'parallel', blockId: 'siblings', blocks: [
    { kind: 'call', blockId: 'first', role: 'worker', prompt: 'first' },
    { kind: 'call', blockId: 'second', role: 'worker', prompt: 'second' }
  ] },
  { kind: 'return', blockId: 'finish', ref: { nodeId: 'siblings' } }
] } })
const descriptor = (id: ProviderDescriptor['id']): ProviderDescriptor => ({ id, label: id, runtimeProvider: id === 'pi' ? 'pi_rpc' : 'codex_cli', transport: 'fixture', available: true,
  capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } })

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
type DeferredExecution = { result: Deferred<WorkflowProviderExecutionResult>; settled: Deferred<void>; stop: ReturnType<typeof vi.fn> }
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(accept => { resolve = accept }), resolve }
}

export function fixture(store: WorkflowStore = new MemoryWorkflowStore(), slots = new WorkflowSlots(2), body?: WorkflowBlock) {
  const entered = deferred<void>()
  const starts = { first: deferred<void>(), second: deferred<void>() }
  const executions = new Map<string, DeferredExecution>()
  let finishing = false
  const settle = (node: string, execution: DeferredExecution): void => {
    execution.result.resolve({ runId: 'fixture-' + node, status: 'completed', output: node, settled: true })
    execution.settled.resolve()
  }
  const plan = vi.fn<WorkflowServiceOptions['plan']>(async () => ({ output: body ? JSON.stringify({ body }) : planOutput }))
  const execute = vi.fn<WorkflowServiceOptions['execute']>(request => {
    const node = request.taskId.slice(request.taskId.lastIndexOf(':') + 1)
    const value = { result: deferred<WorkflowProviderExecutionResult>(), settled: deferred<void>(), stop: vi.fn(() => true) }
    executions.set(node, value)
    if (node === 'first' || node === 'second') starts[node].resolve()
    if (executions.size === 2) entered.resolve()
    if (finishing) settle(node, value)
    return { result: value.result.promise, settled: value.settled.promise, stop: value.stop }
  })
  const service = new WorkflowService({ store, slots, providerRegistered: id => id === 'pi' || id === 'codex', plan, execute,
    runControls: async binding => ({ descriptor: descriptor(binding.providerId), model: true, stop: true, identity: 'fixture', independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const }) })
  return { service, store, slots, plan, execute, executions, entered, starts,
    settleExecutionsForCleanup: (): void => {
      finishing = true
      for (const [node, execution] of executions) settle(node, execution)
    } }

}

export async function prepared(f: ReturnType<typeof fixture>) {
  const preview = await f.service.planCommand({ command: '/scry-workflow run siblings', workspace: '/fixture', orchestrator, roles: [role] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await f.service.approve(approval)
  return { preview, approval }
}

export async function started(f: ReturnType<typeof fixture>) {
  const { preview, approval } = await prepared(f)
  const running = f.service.start(preview.workflowId, approval)
  await f.entered.promise
  return { preview, approval, running }
}
