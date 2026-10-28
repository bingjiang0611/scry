import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import { FileWorkflowStore, MemoryWorkflowStore, type WorkflowStore, type WorkflowPlanningIntent } from './workflow-store'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { WorkflowSlots } from './workflow-runner'
import { parseWorkflowRouteDecision, workflowRoutingPrompt } from '../shared/workflow-route'

const role = { role: 'orchestrator' as const, providerId: 'codex' as const }
const base = { commandId: 'route-command-one', command: 'summarise the failing build', workspace: '/fixture',
  orchestrator: role, roles: [] }
const body = { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'call', blockId: 'scan', role: 'orchestrator', prompt: 'inspect' },
  { kind: 'return', blockId: 'finish', ref: { nodeId: 'scan' } }
] }
function descriptor(id: ProviderId): ProviderDescriptor {
  return { id, label: id, runtimeProvider: 'codex_cli', transport: 'fixture', available: true,
    capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }
}
function fixture(store: WorkflowStore = new MemoryWorkflowStore(), reply = JSON.stringify({ route: 'direct' })) {
  const plan = vi.fn<(request: { route?: true; goal: string }) => Promise<{ output: string }>>(async () => ({ output: reply }))
  const service = new WorkflowService({ store, slots: new WorkflowSlots(2), providerRegistered: () => true,
    runControls: async input => ({ descriptor: descriptor(input.providerId), model: true, stop: true, identity: 'fixture-runtime',
      independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const }), plan,
    execute: () => ({ result: Promise.resolve({ runId: 'fixture', status: 'completed' as const, settled: true }), stop: () => true }) } satisfies WorkflowServiceOptions)
  return { service, plan, store }
}
async function intents(store: WorkflowStore): Promise<WorkflowPlanningIntent[]> {
  const found: WorkflowPlanningIntent[] = []
  for await (const intent of store.planningIntents()) found.push(intent)
  return found
}

describe('workflow routing decides before it plans', () => {
  it('tells manual routing to recognize explicit intent without upgrading ordinary tasks', () => {
    const prompt = workflowRoutingPrompt('orchestrator', 'arbitrary words', 'frozen authoring contract', 'manual')
    expect(prompt).toContain('MANUAL')
    expect(prompt).toContain('explicitly asks')
    expect(prompt).toContain('ordinary tasks')
    expect(prompt).toContain('frozen authoring contract')
  })

  it('requires auto routing to keep even a one-node substantive task on the workflow path', () => {
    const prompt = workflowRoutingPrompt('orchestrator', 'fix one line', 'contract', 'auto')
    expect(prompt).toContain('AUTO')
    expect(prompt).toContain('single call')
    expect(prompt).not.toContain('when one agent answer is enough')
  })

  it('freezes the requested routing mode into the invocation and receipt identity', async () => {
    const f = fixture()
    const request = { ...base, routingMode: 'manual' as const }
    await f.service.routeCommand(request)
    expect(f.plan).toHaveBeenCalledWith(expect.objectContaining({ route: true, routingMode: 'manual' }))
    await expect(f.service.routeCommand(request)).resolves.toEqual({ kind: 'direct' })
    await expect(f.service.routeCommand({ ...request, routingMode: 'auto' })).rejects.toThrow(/已用于另一请求/)
    expect(f.plan).toHaveBeenCalledOnce()
    const cold = fixture(f.store)
    await expect(cold.service.routeCommand(request)).resolves.toEqual({ kind: 'direct' })
    expect(cold.plan).not.toHaveBeenCalled()
  })

  it('persists edit intent without publishing a root or spending a second call, including cold file readback', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'scry-edit-route-'))
    const store = new FileWorkflowStore(userData)
    const target = { scope: 'personal' as const, templateId: '341c060d-180c-40ab-945f-a093dca23271' }
    const f = fixture(store, JSON.stringify({ route: 'template_edit', target }))
    const cold = fixture(store)
    try {
      await expect(f.service.routeCommand(base)).resolves.toEqual({ kind: 'template_edit', target })
      const [intent] = await intents(store)
      expect(intent).toMatchObject({ status: 'completed', route: 'template_edit', routeTarget: target, scopeSettled: true })
      expect(await store.load(intent.workflowId)).toBeUndefined()
      await expect(cold.service.routeCommand(base)).resolves.toEqual({ kind: 'template_edit', target })
      expect(f.plan).toHaveBeenCalledOnce()
      expect(cold.plan).not.toHaveBeenCalled()
      await store.savePlanningIntent({ ...intent, route: 'direct' })
      await expect(store.loadPlanningIntent(intent.workflowId)).rejects.toThrow(/编辑目标/)
    } finally { f.service.close(); cold.service.close(); await rm(userData, { recursive: true, force: true }) }
  })

  it('retains an unspecified edit target for explicit selection and rejects forged target authority', () => {
    expect(parseWorkflowRouteDecision('{"route":"template_edit"}')).toEqual({ route: 'template_edit' })
    const target = { scope: 'personal', templateId: '341c060d-180c-40ab-945f-a093dca23271' }
    for (const invalid of [{ route: 'template_edit', body }, { route: 'template_edit', target: null },
      { route: 'template_edit', target: { ...target, workspace: '/elsewhere' } },
      { route: 'template_edit', target: { ...target, revisionHash: 'a'.repeat(64) } },
      { route: 'template_edit', target: { ...target, scope: 'unknown' } },
      { route: 'template_edit', target: { ...target, templateId: '../escape' } }]) {
      expect(() => parseWorkflowRouteDecision(JSON.stringify(invalid))).toThrow()
    }
  })

  it('spends exactly one routing call and publishes no program for a direct answer', async () => {
    const f = fixture()
    await expect(f.service.routeCommand(base)).resolves.toEqual({ kind: 'direct' })
    expect(f.plan).toHaveBeenCalledOnce()
    expect(f.plan.mock.calls[0][0]).toMatchObject({ route: true, goal: 'summarise the failing build' })
    // The decision is durable evidence, but no root exists to approve or start.
    expect(await intents(f.store)).toMatchObject([{ commandId: base.commandId, status: 'completed', route: 'direct',
      scopeSettled: true, result: { output: JSON.stringify({ route: 'direct' }) } }])
  })

  it('surfaces a clarification without planning a program or dispatching', async () => {
    const f = fixture(undefined, JSON.stringify({ route: 'clarification', question: 'Which repository?' }))
    await expect(f.service.routeCommand(base)).resolves.toEqual({ kind: 'clarification', question: 'Which repository?' })
    expect(f.plan).toHaveBeenCalledOnce()
    expect(await intents(f.store)).toMatchObject([{ status: 'completed', route: 'clarification', routeQuestion: 'Which repository?' }])
  })

  it('publishes an awaiting-approval draft for a workflow decision and replays it from evidence', async () => {
    const f = fixture(undefined, JSON.stringify({ route: 'workflow', body }))
    const routed = await f.service.routeCommand(base)
    expect(routed).toMatchObject({ kind: 'workflow', preview: { userGoal: base.command, workspace: base.workspace } })
    if (routed.kind !== 'workflow') throw new Error('unreachable')
    const record = await f.store.load(routed.preview.workflowId)
    expect(record?.progress.state).toBe('awaiting_approval')
    expect(record?.preview.programRevision).toBe(routed.preview.programRevision)
    // Same commandId: the receipt replays without a second call.
    await expect(f.service.routeCommand(base)).resolves.toEqual(routed)
    expect(f.plan).toHaveBeenCalledOnce()
    // Cold service over the same durable evidence: still no second call.
    const cold = fixture(f.store)
    await expect(cold.service.routeCommand(base)).resolves.toEqual(routed)
    expect(cold.plan).not.toHaveBeenCalled()
  })

  it('rejects a malformed decision instead of guessing a route', async () => {
    for (const reply of [JSON.stringify({ route: 'workflow' }), JSON.stringify({ route: 'direct', body }),
      JSON.stringify({ route: 'clarification', question: '' }), JSON.stringify({ route: 'maybe' }), 'not json']) {
      const f = fixture(undefined, reply)
      await expect(f.service.routeCommand(base)).rejects.toThrow()
      const [intent] = await intents(f.store)
      expect(intent.route).toBeUndefined()
      expect(intent.status).not.toBe('completed')
    }
  })

  it('never routes an empty message and never reuses another request under the same commandId', async () => {
    const f = fixture()
    await expect(f.service.routeCommand({ ...base, command: '   ' })).rejects.toThrow()
    expect(f.plan).not.toHaveBeenCalled()
    await f.service.routeCommand(base)
    await expect(f.service.routeCommand({ ...base, command: 'different message' })).rejects.toThrow(/已用于另一请求/)
    expect(f.plan).toHaveBeenCalledOnce()
  })
})
