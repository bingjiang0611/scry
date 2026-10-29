import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowRunSettlementStore } from './workflow-run-settlement-store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-workflow-settlement-'))
  roots.push(root)
  return { root, store: new WorkflowRunSettlementStore(root) }
}

const settlement = {
  schemaVersion: 1 as const,
  workflowId: 'workflow-test',
  taskId: `workflow-test:${'a'.repeat(64)}:worker`,
  attemptId: '00000000-0000-4000-8000-000000000001',
  runId: 'workflow-00000000-0000-4000-8000-000000000001',
  status: 'completed' as const,
  settledAt: 1,
  source: 'app_run_terminal' as const
}

describe('workflow run settlement store', () => {
  it('cold-loads an exact App terminal receipt for one attempt', async () => {
    const { root, store } = await fixture()
    await store.save(settlement)
    await expect(new WorkflowRunSettlementStore(root).load(settlement.attemptId)).resolves.toEqual(settlement)
  })

  it('rejects a receipt whose hashed filename contains another attempt identity', async () => {
    const { root, store } = await fixture()
    await store.save(settlement)
    const directory = join(root, 'workflow-run-settlements-v1')
    const path = (await readdir(directory))[0]!
    const value = JSON.parse(await readFile(join(directory, path), 'utf8')) as Record<string, unknown>
    value.attemptId = '00000000-0000-4000-8000-000000000002'
    value.runId = 'workflow-00000000-0000-4000-8000-000000000002'
    await writeFile(join(directory, path), JSON.stringify(value))
    await expect(store.load(settlement.attemptId)).rejects.toThrow('身份不匹配')
  })
})
