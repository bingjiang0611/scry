import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileWorkflowStore } from './workflow-store'
import type { WorkflowStoreRecord } from './workflow-store'
import { WORKFLOW_MAX_STOP_REQUESTS } from '../shared/workflow'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'scry-workflow-store-'))
  directories.push(path)
  return { path, store: new FileWorkflowStore(path) }
}
function record(id: string): WorkflowStoreRecord {
  const role = { role: 'worker' as const, providerId: 'pi' as const }
  const program = { schemaVersion: 1 as const, workflowId: id, programRevision: 'rev', userGoal: 'goal', workspace: '/fixture', roles: [role], body: { kind: 'call' as const, blockId: 'call', role: 'worker' as const, prompt: 'task' } }
  return { preview: { workflowId: id, programRevision: 'rev', userGoal: 'goal', workspace: '/fixture', orchestrator: role, program, plannedCalls: 1, roles: [], state: 'ready', unavailableReasons: [], observedAt: 1 },
    progress: { workflowId: id, programRevision: 'rev', workspace: '/fixture', goal: 'goal', state: 'queued', attempts: [], dispatchAttempts: 0, slots: { limit: 1, inUse: 0, queued: 0 }, updatedAt: 1 }, intents: [], outcomes: [] }
}
describe('actual workflow filesystem', () => {
  it.each(['identity', 'duplicate', 'limit'] as const)('fails closed for corrupt stop receipts: %s', async kind => {
    const { store } = await fixture()
    const value = record('stop-corrupt')
    value.stopRequests = kind === 'limit'
      ? Array.from({ length: WORKFLOW_MAX_STOP_REQUESTS + 1 }, (_, index) => ({ commandId: `stop-${index}`, requestedAt: 1 }))
      : kind === 'duplicate' ? [{ commandId: 'same', requestedAt: 1 }, { commandId: 'same', requestedAt: 2 }]
        : [{ commandId: '../invalid', requestedAt: 1 }]
    await store.save(value)
    await expect(store.load('stop-corrupt')).rejects.toThrow('停止收据合同无效')
  })

  it('commits the immutable planning body before its small durable receipt', async () => {
    const { path, store } = await fixture()
    await store.savePlanningIntent({ workflowId: 'plan', role: 'orchestrator', providerId: 'pi', workspace: '/fixture', goal: 'inspect',
      createdAt: 1, status: 'running', scopeSettled: true, result: { output: 'PRIVATE_PLANNING_BODY', archiveRef: 'fixture/archive' } })
    const reopened = new FileWorkflowStore(path)
    const intent = await reopened.loadPlanningIntent('plan')
    expect(intent?.result?.output).toBeUndefined()
    expect(intent?.result?.archiveRef).toBe('fixture/archive')
    expect(await readFile(join(path, 'workflows', intent!.result!.outputRef!), 'utf8')).toBe('PRIVATE_PLANNING_BODY')
    expect(await readFile(join(path, 'workflows', 'plan.planning.json'), 'utf8')).not.toContain('PRIVATE_PLANNING_BODY')
  })
  it('reopens and pages all records once, without double-closing the directory iterator', async () => {
    const { path, store } = await fixture()
    for (const id of ['c', 'a', 'b']) await store.save(record(id))
    const reopened = new FileWorkflowStore(path)
    const first = await reopened.listPage(undefined, 2)
    expect(first.records.map(r => r.preview.workflowId)).toEqual(['a', 'b'])
    expect(first.nextCursor).toBeTruthy()
    const last = await reopened.listPage(first.nextCursor, 2)
    expect(last.records.map(r => r.preview.workflowId)).toEqual(['c'])
    expect(last.nextCursor).toBeUndefined()
    const planning = []
    for await (const intent of reopened.planningIntents()) planning.push(intent)
    expect(planning).toEqual([])
  })
  it('round-trips non-dispatch proof without adding proof to legacy unknown records', async () => {
    const { path, store } = await fixture()
    const failed = record('refused')
    failed.progress.state = 'failed'
    failed.progress.dispatchAttempts = 1
    failed.intents.push({ workflowId: 'refused', programRevision: 'rev', taskId: 'task', attemptId: 'attempt', role: 'worker', providerId: 'pi', createdAt: 1 })
    failed.outcomes.push({ attemptId: 'attempt', taskId: 'task', nodeId: 'call', role: 'worker', providerId: 'pi', actualModelStatus: 'unknown',
      state: 'failed', settled: true, providerDispatch: 'not_attempted' })
    failed.progress.attempts = failed.outcomes
    await store.save(failed)
    await store.savePlanningIntent({ workflowId: 'refused-plan', role: 'orchestrator', providerId: 'pi', workspace: '/fixture', goal: 'inspect',
      createdAt: 1, status: 'failed', scopeSettled: true, providerDispatch: 'not_attempted' })
    const legacy = record('legacy')
    legacy.outcomes = [{ ...failed.outcomes[0], state: 'unknown', settled: false }]
    delete legacy.outcomes[0].providerDispatch
    await store.save(legacy)
    const reopened = new FileWorkflowStore(path)
    expect((await reopened.load('refused'))?.outcomes[0]).toMatchObject({ state: 'failed', settled: true, providerDispatch: 'not_attempted' })
    expect((await reopened.load('refused'))?.progress.attempts[0].providerDispatch).toBe('not_attempted')
    expect(await reopened.loadPlanningIntent('refused-plan')).toMatchObject({ status: 'failed', scopeSettled: true, providerDispatch: 'not_attempted' })
    const old = (await reopened.load('legacy'))!.outcomes[0]
    expect(old.settled).toBe(false)
    expect(old.providerDispatch).toBeUndefined()
  })
  it('rejects invalid identity instead of aliasing a different existing record', async () => {
    const { store } = await fixture()
    await store.save(record('a_b'))
    await expect(store.load('a/b')).rejects.toThrow()
  })
  it('reports corrupt stored content as unavailable, not as an absent run', async () => {
    const { path, store } = await fixture()
    await mkdir(join(path, 'workflows'))
    await writeFile(join(path, 'workflows', 'bad.json'), 'null')
    await expect(store.load('bad')).rejects.toThrow()
  })
})
