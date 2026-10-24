import { mkdtemp, readdir, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowControlFrame, WorkflowEvaluation } from '../shared/workflow'
import { FileWorkflowStore } from './workflow-store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'scry-workflow-control-')); roots.push(root); return root }
const known = (value: Extract<WorkflowEvaluation, { state: 'known' }>['value']): WorkflowEvaluation => ({ state: 'known', value, derivedFrom: [] })
function frame(workflowId = 'workflow-frame-test'): Omit<WorkflowControlFrame, 'revision'> {
  return { schemaVersion: 1, workflowId, programRevision: 'revision-test', frameId: 'node', nodeId: 'node', scopePath: [], inputKey: '0'.repeat(64), phase: 'entered' }
}

describe('durable control/value store', () => {
  it('serializes CAS across independent store objects, not just one in-memory queue', async () => {
    const root = await temporary(), first = new FileWorkflowStore(root), second = new FileWorkflowStore(root)
    const results = await Promise.allSettled([first.saveFrame(frame(), 0), second.saveFrame(frame(), 0)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await new FileWorkflowStore(root).loadFrame('workflow-frame-test', 'node')).toMatchObject({ phase: 'entered', revision: 1 })
  })
  it('refuses a selected frame without its decision or a terminal frame without its result artifact', async () => {
    const store = new FileWorkflowStore(await temporary())
    await expect(store.saveFrame({ ...frame(), phase: 'selected' }, 0)).rejects.toThrow('合同无效')
    await expect(store.saveFrame({ ...frame(), phase: 'completed' }, 0)).rejects.toThrow('合同无效')
    await expect(store.saveFrame({ ...frame(), phase: 'unknown' }, 0)).rejects.toThrow('合同无效')
    expect(await store.loadFrame('workflow-frame-test', 'node')).toBeUndefined()
  })

  it('keeps the committed choice/input immutable and forbids terminal rewrites', async () => {
    const store = new FileWorkflowStore(await temporary()), initial = await store.saveFrame(frame(), 0)
    const decisionRef = await store.saveValue(initial.workflowId, 'decision', known(false))
    const selected = await store.saveFrame({ ...initial, phase: 'selected', arm: 'else', decisionRef }, 1)
    await expect(store.saveFrame({ ...selected, arm: 'then' }, 2)).rejects.toThrow('选择不可改写')
    await expect(store.saveFrame({ ...selected, inputKey: '1'.repeat(64) }, 2)).rejects.toThrow('身份已变化')
    const resultRef = await store.saveValue(initial.workflowId, 'result', known({ arm: 'else', value: false }))
    const completed = await store.saveFrame({ ...selected, phase: 'completed', resultRef }, 2)
    await expect(store.saveFrame({ ...completed, phase: 'entered' }, 3)).rejects.toThrow('不可改写')
    expect(await store.loadValue(initial.workflowId, completed.resultRef!)).toMatchObject({ state: 'known', value: { arm: 'else', value: false } })
  })
  it('cannot reset an unknown frame to admission or erase a selected choice', async () => {
    const store = new FileWorkflowStore(await temporary()), initial = await store.saveFrame(frame(), 0)
    const decisionRef = await store.saveValue(initial.workflowId, 'decision', known(true))
    const selected = await store.saveFrame({ ...initial, phase: 'selected', arm: 'then', decisionRef }, 1)
    await expect(store.saveFrame({ ...selected, phase: 'entered' }, 2)).rejects.toThrow('选择不可改写')
    const resultRef = await store.saveValue(initial.workflowId, 'result', { state: 'unknown', reason: 'native result unavailable', derivedFrom: ['attempt-1'] })
    const unknown = await store.saveFrame({ ...selected, phase: 'unknown', resultRef }, 2)
    await expect(store.saveFrame({ ...unknown, phase: 'entered' }, 3)).rejects.toThrow('不可改写')
    await expect(store.saveFrame({ ...unknown, phase: 'completed' }, 3)).rejects.toThrow('不可改写')
  })

  it('verifies immutable content and workflow containment; missing is never null/empty', async () => {
    const root = await temporary(), store = new FileWorkflowStore(root)
    const ref = await store.saveValue('workflow-value-test', 'data', known({ zero: 0, flag: false, nil: null }))
    expect(await new FileWorkflowStore(root).loadValue(ref.workflowId, ref)).toMatchObject({ state: 'known', value: { zero: 0, flag: false, nil: null } })
    await expect(store.loadValue('another-workflow', ref)).rejects.toThrow('引用身份')
    const files = await readdir(join(root, 'workflows'))
    await appendFile(join(root, 'workflows', files.find(file => file.endsWith('.value.json'))!), ' ')
    await expect(store.loadValue(ref.workflowId, ref)).rejects.toThrow('校验失败')
    await expect(store.loadValue(ref.workflowId, { ...ref, hash: '1'.repeat(64) })).rejects.toThrow('缺失')
    await expect(store.saveValue(ref.workflowId, 'bad', known(NaN))).rejects.toThrow()
  })
  it('supports maximum authorized IDs without exceeding filesystem component bounds', async () => {
    const root = await temporary(), store = new FileWorkflowStore(root)
    const ref = await store.saveValue('w'.repeat(96), 'k'.repeat(96), known([]))
    expect(await store.loadValue(ref.workflowId, ref)).toMatchObject({ state: 'known', value: [] })
    expect((await readdir(join(root, 'workflows'))).every(file => Buffer.byteLength(file) <= 255)).toBe(true)
  })
})
