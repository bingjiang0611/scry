import { vi } from 'vitest'
import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import { FileWorkflowStore, MemoryWorkflowStore } from './workflow-store'
import type { WorkflowPlanningIntent, WorkflowStoreRecord } from './workflow-store'
import { WORKFLOW_MAX_STOP_REQUESTS, type WorkflowControlFrame } from '../shared/workflow'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { WorkflowDispatch, WorkflowSlots } from './workflow-runner'
import type { WorkflowProviderExecutionResult } from './workflow-runner'

export const role = { role: 'orchestrator' as const, providerId: 'codex' as const }
export const worker = { role: 'worker' as const, providerId: 'pi' as const, agentProfileId: 'pi:default', requestedModel: { providerId: 'openai', id: 'fixture' } }
export const request = { commandId: 'plan-command', command: '/scry-workflow run inspect', workspace: '/fixture', orchestrator: role, roles: [worker] }
export const output = JSON.stringify({ body: { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'call', blockId: 'scan', role: 'worker', prompt: 'inspect' },
  { kind: 'return', blockId: 'finish', ref: { nodeId: 'scan' } }
] } })
export function descriptor(id: ProviderId): ProviderDescriptor {
  return { id, label: id, runtimeProvider: id === 'pi' ? 'pi_rpc' : 'codex_cli', transport: 'fixture', available: true,
    capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }
}
export function fixture(store: FileWorkflowStore | MemoryWorkflowStore = new MemoryWorkflowStore(), changes: Partial<WorkflowServiceOptions> = {}) {
  const plan = vi.fn(async () => ({ output }))
  const execute = vi.fn<WorkflowServiceOptions['execute']>(() => ({ result: Promise.resolve({ runId: 'fixture', status: 'completed' as const, output: 'final', archiveRef: 'fixture/archive', settled: true }), stop: () => true }))
  const slots = new WorkflowSlots(2)
  const service = new WorkflowService({ store, slots, providerRegistered: () => true,
    runControls: async binding => ({ descriptor: descriptor(binding.providerId), model: true, stop: true, identity: 'fixture-runtime', independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const }), plan, execute, ...changes })
  return { service, plan, execute, slots, store }
}

export class ParentCheckpointStore extends MemoryWorkflowStore {
  fail = true
  override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, revision: number) {
    if (this.fail && frame.nodeId === 'root' && frame.cursor === 1) throw new Error('fixture parent checkpoint failure')
    return super.saveFrame(frame, revision)
  }
}

export { FileWorkflowStore, MemoryWorkflowStore, WORKFLOW_MAX_STOP_REQUESTS, WorkflowDispatch, WorkflowSlots }
export type { WorkflowControlFrame, WorkflowPlanningIntent, WorkflowProviderExecutionResult, WorkflowServiceOptions, WorkflowStoreRecord }
