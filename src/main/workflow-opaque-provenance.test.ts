import { describe, expect, it } from 'vitest'
import type { WorkflowEvaluation } from '../shared/workflow'
import { MemoryWorkflowStore } from './workflow-store'
import { workflowOpaqueProvenance } from './workflow-opaque-provenance'

describe('main provenance traversal', () => {
  it('resolves a bounded linear pure-binding chain without confusing graph depth with expression nesting', async () => {
    const store = new MemoryWorkflowStore()
    let value: WorkflowEvaluation = { state: 'known', value: { id: 'item' }, derivedFrom: [] }
    for (let index = 0; index < 80; index++) {
      const reference = await store.saveValue('root', 'binding_' + index, value)
      value = { ...value, derivedFrom: [`value:${reference.key}:${reference.hash}`] }
    }
    expect(await workflowOpaqueProvenance(store, 'root', value)).toEqual([])
  })
})
