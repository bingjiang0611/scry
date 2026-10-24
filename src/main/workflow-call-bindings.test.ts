import { describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowEvaluation } from '../shared/workflow'
import { createWorkflowCallInputs } from './workflow-call-semantics'
import { call, fixture } from './workflow-revision.fixture'

const consume: Extract<WorkflowBlock, { kind: 'call' }> = { ...call('consume'), inputRefs: [{ nodeId: 'data', path: ['text'] }] }
const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'bind', blockId: 'data', value: { kind: 'literal', value: { text: 'bound' } } }, consume,
  { kind: 'return', blockId: 'finish', ref: { nodeId: 'consume' } }
] }

describe('committed call input binding references', () => {
  it('selects an existing main binding without persisting a second scalar artifact', async () => {
    const f = await fixture(false, false, false, body)
    try {
      const value: WorkflowEvaluation = { state: 'known', value: { text: 'bound' }, derivedFrom: [] }
      const reference = await f.store.saveValue(f.preview.workflowId, 'main_binding', value)
      const save = vi.spyOn(f.store, 'saveValue')
      const inputs = await createWorkflowCallInputs(f.store, f.preview, consume,
        { path: [], bindings: new Map([['data', { ...value, derivedFrom: [`value:${reference.key}:${reference.hash}`] }]]) }, 'input')
      expect(inputs.inputs[0]).toMatchObject({ bindingRef: reference, path: ['text'] })
      expect(inputs.inputs[0].valueRef).toBeUndefined()
      expect(save).not.toHaveBeenCalled()
      expect(await f.store.loadValue(f.preview.workflowId, reference)).toEqual(value)
    } finally { await f.cleanup() }
  })

  it('keeps a shadowing binding origin instead of choosing an equal-valued ancestor item', async () => {
    const mapped: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'bind', blockId: 'rows', value: { kind: 'literal', value: [{ id: 'entry', text: 'bound' }] } },
      { kind: 'map', blockId: 'jobs', items: { kind: 'ref', name: 'rows' }, item: 'data', key: ['id'], maxItems: 1, body: consume },
      { kind: 'return', blockId: 'finish', ref: { nodeId: 'jobs' } }
    ] }
    const f = await fixture(false, false, false, mapped)
    try {
      const value: WorkflowEvaluation = { state: 'known', value: { id: 'entry', text: 'bound' }, derivedFrom: [] }
      const itemRef = await f.store.saveValue(f.preview.workflowId, 'ancestor_item', value)
      const stateRef = await f.store.saveValue(f.preview.workflowId, 'current_state', value)
      const inputs = await createWorkflowCallInputs(f.store, f.preview, consume, {
        path: [], bindings: new Map([['data', { ...value, derivedFrom: [`value:${stateRef.key}:${stateRef.hash}`] }]]),
        callContexts: [{ kind: 'map', frameId: 'map-frame', blockId: 'jobs', key: 'entry', itemRef, collection: false }]
      }, 'input')
      expect(inputs.inputs[0].bindingRef).toEqual(stateRef)
      expect(inputs.inputs[0].bindingRef).not.toEqual(itemRef)
    } finally { await f.cleanup() }
  })

  it('does not treat payload strings that look like main references as source authority', async () => {
    const f = await fixture(false, false, false, body)
    try {
      const value: WorkflowEvaluation = { state: 'known', value: { text: 'bound', derivedFrom: ['value:invented:' + 'a'.repeat(64)] }, derivedFrom: [] }
      const inputs = await createWorkflowCallInputs(f.store, f.preview, consume, { path: [], bindings: new Map([['data', value]]) }, 'input')
      expect(inputs.inputs[0].bindingRef).toBeUndefined()
      expect(inputs.inputs[0].valueRef).toBeDefined()
      expect(await f.store.loadValue(f.preview.workflowId, inputs.inputs[0].valueRef!)).toEqual({ state: 'known', value: 'bound', derivedFrom: [] })
    } finally { await f.cleanup() }
  })
})
