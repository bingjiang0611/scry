import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileWorkflowStore } from './workflow-store'
import type { WorkflowStoreRecord } from './workflow-store'

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
