import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowEvaluation, WorkflowExpression } from '../shared/workflow'
import { collectionDescriptor } from './workflow-collections'
import { evaluateWorkflowExpression, workflowField } from './workflow-expressions'
import { FileWorkflowStore, MemoryWorkflowStore } from './workflow-store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-collection-authority-')); roots.push(root)
  const store = new FileWorkflowStore(root), workflowId = 'authority'
  const collection = await store.saveCollection(workflowId, 'items', [{ key: 'a', index: 0, state: 'failed', settled: true, error: 'retained failure' }], true)
  const value: Extract<WorkflowEvaluation, { state: 'known' }> = { state: 'known', value: [{ key: 'group-a', nested: collectionDescriptor(collection) }], derivedFrom: ['source'],
    collectionFields: [{ path: ['0', 'nested'], collection }] }
  return { root, store, workflowId, collection, value }
}
const field = (source: WorkflowExpression, path: string[]): WorkflowExpression => ({ kind: 'field', source, path })
const ref: WorkflowExpression = { kind: 'ref', name: 'source' }

describe('nested collection read authority', () => {
  it('cold reads the exact referenced manifest before exposing a projected count', async () => {
    const f = await fixture(), reference = await f.store.saveValue(f.workflowId, 'parent', f.value)
    const value = await new FileWorkflowStore(f.root).loadValue(f.workflowId, reference)
    const projected = evaluateWorkflowExpression(field(ref, ['0', 'nested']), new Map([['source', value]]))
    expect(projected).toMatchObject({ state: 'known', collection: f.collection })
    expect(evaluateWorkflowExpression({ kind: 'count', value: field(ref, ['0', 'nested']) }, new Map([['source', value]]))).toMatchObject({ state: 'known', value: 1 })
    const plain: WorkflowEvaluation = { state: 'known', value: f.value.value, derivedFrom: [] }
    const descriptor = evaluateWorkflowExpression(field(ref, ['0', 'nested']), new Map([['source', plain]]))
    expect(descriptor).not.toHaveProperty('collection')
    expect(evaluateWorkflowExpression({ kind: 'count', value: field(ref, ['0', 'nested']) }, new Map([['source', plain]]))).toMatchObject({ state: 'unknown' })
  })

  it.each(['foreign', 'wrong-position', 'duplicate', 'root-position', 'extra-field'] as const)('rejects forged metadata: %s', async kind => {
    const f = await fixture(), value = structuredClone(f.value), authority = value.collectionFields![0]
    if (kind === 'foreign') authority.collection.reference.workflowId = 'another-workflow'
    if (kind === 'wrong-position') authority.path = ['0', 'key']
    if (kind === 'duplicate') value.collectionFields!.push(structuredClone(authority))
    if (kind === 'root-position') authority.path = []
    if (kind === 'extra-field') Object.assign(authority, { enabled: true })
    for (const store of [f.store, new MemoryWorkflowStore()]) await expect(store.saveValue(f.workflowId, 'forged', value)).rejects.toThrow()
  })

  it('does not accept missing manifests or a forged sealed count on cold read', async () => {
    const f = await fixture(), reference = await f.store.saveValue(f.workflowId, 'parent', f.value)
    const wrong = structuredClone(f.value)
    wrong.collectionFields![0].collection.count = 2
    if (Array.isArray(wrong.value) && typeof wrong.value[0] === 'object' && wrong.value[0] !== null && !Array.isArray(wrong.value[0])) wrong.value[0].nested = collectionDescriptor(wrong.collectionFields![0].collection)
    const forged = await f.store.saveValue(f.workflowId, 'wrong-count', wrong)
    await expect(new FileWorkflowStore(f.root).loadValue(f.workflowId, forged)).rejects.toThrow()
    const directory = join(f.root, 'workflows'), manifests = (await readdir(directory)).filter(name => name.endsWith('.collection.json'))
    expect(manifests).toHaveLength(1)
    await rm(join(directory, manifests[0]))
    await expect(new FileWorkflowStore(f.root).loadValue(f.workflowId, reference)).rejects.toThrow()
  })

  it('validates a repeated identical manifest only once per value read', async () => {
    const f = await fixture(), value: WorkflowEvaluation = { ...f.value, value: [f.value.value, f.value.value], collectionFields: [
      { path: ['0', '0', 'nested'], collection: f.collection }, { path: ['1', '0', 'nested'], collection: f.collection }
    ] }
    const reference = await f.store.saveValue(f.workflowId, 'repeated', value), load = vi.spyOn(f.store, 'loadCollection')
    await f.store.loadValue(f.workflowId, reference)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it.each(['concat', 'group', 'unique', 'filter', 'partition'] as const)('preserves authority through %s without granting sibling fields', async kind => {
    const f = await fixture(), scope = new Map<string, WorkflowEvaluation>([['source', f.value]])
    let expression: WorkflowExpression, path: string[]
    if (kind === 'concat') {
      expression = { kind, values: [{ kind: 'literal', value: ['prefix'] }, ref] }; path = ['1', 'nested']
    } else if (kind === 'group' || kind === 'unique') {
      expression = { kind, items: ref, key: ['key'] }; path = ['0', 'members', '0', 'nested']
    } else {
      expression = { kind, items: ref, item: 'row', when: { kind: 'compare', operator: 'eq', left: { kind: 'count', value: field({ kind: 'ref', name: 'row' }, ['nested']) }, right: { kind: 'literal', value: 1 } } }
      path = ['matched', '0', 'value', 'nested']
    }
    const transformed = evaluateWorkflowExpression(expression, scope)
    expect(transformed.state).toBe('known')
    const reference = await f.store.saveValue(f.workflowId, 'transformed', transformed)
    const cold = await new FileWorkflowStore(f.root).loadValue(f.workflowId, reference)
    if (cold.state !== 'known') throw new Error('missing transformed fixture')
    expect(workflowField(cold.value, path, cold.derivedFrom, cold)).toMatchObject({ state: 'known', collection: f.collection })
    expect(workflowField(cold.value, kind === 'concat' ? ['0'] : kind === 'group' || kind === 'unique' ? ['0', 'key'] : ['matched', '0', 'index'], cold.derivedFrom, cold)).not.toHaveProperty('collection')
  })
})
