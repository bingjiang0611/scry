import { describe, expect, it } from 'vitest'
import type { WorkflowBlock, WorkflowPlanPreview } from '../shared/workflow'
import { callBlocks } from './workflow-program'
import { workflowFixtureApproval } from './workflow-runner.fixture'
import { MemoryWorkflowStore } from './workflow-store'
import { WorkflowRunner, WorkflowSlots, type WorkflowProviderExecutionResult } from './workflow-runner'

function preview(body: WorkflowBlock): WorkflowPlanPreview {
  const role = { role: 'worker' as const, providerId: 'codex' as const }
  const sequence: WorkflowBlock = body.kind === 'sequence'
    ? { ...body, blocks: [...body.blocks, { kind: 'return', blockId: 'fixture-return', ref: { nodeId: body.blocks.at(-1)!.blockId } }] }
    : { kind: 'sequence', blockId: 'fixture-entry', blocks: [body, { kind: 'return', blockId: 'fixture-return', ref: { nodeId: body.blockId } }] }
  return {
    workflowId: 'workflow-safety', programRevision: 'revision', userGoal: 'inspect', workspace: '/fixture',
    orchestrator: { ...role, role: 'orchestrator' },
    roles: [{ ...role, actualModelStatus: 'unknown', startIndependentSession: 'available', observeTerminalOutput: 'available', confirmStopConvergence: 'available', state: 'available' }],
    program: { schemaVersion: 1, workflowId: 'workflow-safety', programRevision: 'revision', userGoal: 'inspect', workspace: '/fixture', roles: [role], body: sequence },
    plannedCalls: callBlocks(body).length, state: 'ready', unavailableReasons: [], observedAt: 1
  }
}
const call = (blockId: string): WorkflowBlock => ({ kind: 'call', blockId, role: 'worker', prompt: blockId })
const approve = (runner: WorkflowRunner, plan: WorkflowPlanPreview) => {
  const approval = workflowFixtureApproval(plan)
  runner.approve(plan, approval)
  return approval
}

// Independent negative controls for the initial implementation. These guard
// actual dispatch counts, not UI labels or implementation-private branches.
describe('workflow safety regressions', () => {
  it('failure blocks sequence dependencies rather than dispatching later calls', async () => {
    const starts: string[] = []
    const runner = new WorkflowRunner({ store: new MemoryWorkflowStore(), execute: request => {
      starts.push(request.taskId)
      return { result: Promise.resolve({ runId: 'fixture', status: 'failed', settled: true }), stop: () => true }
    } })
    const plan = preview({ kind: 'sequence', blockId: 'root', blocks: [call('first'), call('dependent')] })
    const result = await runner.start(plan, approve(runner, plan))
    expect(starts).toHaveLength(1)
    expect(result.state).toBe('failed')
  })

  it('a completed root cannot be re-dispatched with the old approval and reset its budget', async () => {
    let starts = 0
    const runner = new WorkflowRunner({ store: new MemoryWorkflowStore(), execute: () => {
      starts++
      return { result: Promise.resolve({ runId: 'fixture', status: 'completed', output: 'report', settled: true }), stop: () => true }
    } })
    const plan = preview(call('first'))
    const approval = approve(runner, plan)
    await runner.start(plan, approval)
    await runner.start(plan, approval).catch(() => undefined)
    expect(starts).toBe(1)
  })

  it('queued calls do not consume dispatch budget and cannot start after a stop', async () => {
    let release!: (result: WorkflowProviderExecutionResult) => void
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const starts: string[] = []
    const runner = new WorkflowRunner({ store: new MemoryWorkflowStore(), slots: new WorkflowSlots(1), execute: request => {
      starts.push(request.taskId)
      started()
      return { result: new Promise(resolve => { release = resolve }), stop: () => true }
    } })
    const plan = preview({ kind: 'parallel', blockId: 'root', blocks: [call('first'), call('queued')] })
    const running = runner.start(plan, approve(runner, plan))
    await startedPromise
    expect(runner.snapshot(plan.workflowId)?.dispatchAttempts).toBe(1)
    expect(runner.stop(plan.workflowId)).toBe(true)
    release({ runId: 'fixture', status: 'stopped', settled: true })
    // Catch implementations which dispatch the queued sibling even after stop.
    await Promise.race([running, Promise.resolve().then(() => Promise.resolve())])
    expect(starts).toHaveLength(1)
    // Release a wrongly-started sibling so the negative control leaves no work.
    if (starts.length > 1) release({ runId: 'fixture-2', status: 'stopped', settled: true })
    await running
  })
})
